import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { asc, eq } from 'drizzle-orm'
import { pino } from 'pino'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../adapters/noop-error-reporter.ts'
import { createRecordEvaluationHandler, RECORD_EVALUATION } from './index.ts'

/**
 * The two properties CONVENTIONS.md asks of every job — that it is idempotent, and that it
 * records its attempts in the database — against a real Postgres, because both of them are
 * claims about what Postgres does rather than about what this code intends.
 *
 * It does not skip when there is no database, for the same reason `packages/db`'s tests do
 * not: a silently-skipped test reads green in CI while proving nothing.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the job tests need a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const ORG = newId('org_')
const PANEL = newId('pnl_')
const PANEL_VERSION = newId('pnv_')
const TRACE = newId('tr_')
const REQUEST_ID = 'ab'.repeat(16)

let db: Database

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 2 })
  await db.insert(schema.orgs).values({ id: ORG, slug: `jobs-${ORG}`, name: 'Job test' })
  await db.insert(schema.panels).values({ id: PANEL, orgId: ORG, slug: 'jobs', name: 'Jobs' })
  await db
    .insert(schema.panelVersions)
    .values({ id: PANEL_VERSION, panelId: PANEL, version: 1, threshold: 0.5 })
  await db.insert(schema.traces).values({
    id: TRACE,
    orgId: ORG,
    panelId: PANEL,
    panelVersionId: PANEL_VERSION,
    requestId: REQUEST_ID,
    artifact: 'the build is broken',
    passed: true,
    score: 1,
    complete: true,
    threshold: 0.5,
  })
})

afterAll(async () => {
  // `orgs` cascades to panels, traces and — through `traces` — the attempt rows.
  await db.delete(schema.orgs).where(eq(schema.orgs.id, ORG))
  await db.close()
})

let reporter: ReturnType<typeof createRecordingErrorReporter>

const handler = (now = Date.parse('2026-08-27T12:00:00Z')) =>
  createRecordEvaluationHandler({
    db,
    clock: createFixedClock(now),
    errorReporter: reporter,
    logger: pino({ level: 'silent' }),
  })

const deliver = (jobId: string, traceId = TRACE, now?: number) =>
  handler(now)({
    jobId,
    queue: RECORD_EVALUATION,
    payload: { trace_id: traceId, request_id: REQUEST_ID },
  })

const attemptsOf = (jobId: string) =>
  db
    .select()
    .from(schema.jobAttempts)
    .where(eq(schema.jobAttempts.jobId, jobId))
    .orderBy(asc(schema.jobAttempts.attempt))

const traceRow = async () => {
  const rows = await db.select().from(schema.traces).where(eq(schema.traces.id, TRACE))
  const row = rows[0]
  if (row === undefined) throw new Error('the fixture trace vanished')
  return row
}

beforeEach(async () => {
  reporter = createRecordingErrorReporter()
  await db.update(schema.traces).set({ recordedAt: null }).where(eq(schema.traces.id, TRACE))
  await db.delete(schema.jobAttempts).where(eq(schema.jobAttempts.traceId, TRACE))
})

describe('the record-evaluation handler', () => {
  test('does its work and records the attempt that did it', async () => {
    const jobId = 'job-first-run'
    await deliver(jobId)

    expect((await traceRow()).recordedAt).not.toBeNull()

    const attempts = await attemptsOf(jobId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.attempt).toBe(1)
    expect(attempts[0]?.status).toBe('completed')
    expect(attempts[0]?.queue).toBe(RECORD_EVALUATION)
    // Both ids, so the ledger joins to the request's logs and to the evaluation (ADR-0010).
    expect(attempts[0]?.requestId).toBe(REQUEST_ID)
    expect(attempts[0]?.traceId).toBe(TRACE)
    expect(attempts[0]?.finishedAt).not.toBeNull()
    expect(attempts[0]?.error).toBeNull()
  })

  test('DELIVERING THE SAME JOB TWICE is a no-op the second time', async () => {
    /**
     * The property the whole design turns on. A queue re-delivers — after a worker dies,
     * after an expiry, after a retry of a job that actually succeeded — so "at least once"
     * is the guarantee on offer and idempotency is how it is survived.
     *
     * The no-op is enforced by Postgres, not by this handler: the write is conditional on
     * `recorded_at IS NULL`, so a re-delivery updates zero rows. A check-then-act would
     * pass this test and still double-write under two concurrent deliveries.
     */
    const jobId = 'job-redelivered'
    await deliver(jobId, TRACE, Date.parse('2026-08-27T12:00:00Z'))
    const afterFirst = (await traceRow()).recordedAt

    await deliver(jobId, TRACE, Date.parse('2026-08-27T13:30:00Z'))
    const afterSecond = (await traceRow()).recordedAt

    // Unchanged — not merely still set. A second write with the later clock would move it.
    expect(afterSecond).toEqual(afterFirst)

    // And the ledger shows BOTH deliveries: the work happened once, the job ran twice, and
    // conflating those two is how a redelivery storm becomes invisible.
    const attempts = await attemptsOf(jobId)
    expect(attempts.map((row) => row.attempt)).toEqual([1, 2])
    expect(attempts.map((row) => row.status)).toEqual(['completed', 'completed'])
  })

  test('counts attempts per job, so two different jobs both start at 1', async () => {
    await deliver('job-a')
    await deliver('job-b')
    expect((await attemptsOf('job-a')).map((row) => row.attempt)).toEqual([1])
    expect((await attemptsOf('job-b')).map((row) => row.attempt)).toEqual([1])
  })

  test('a failure is recorded, reported, and rethrown so the queue retries it', async () => {
    // A trace that does not exist: the foreign key on the ledger refuses the attempt, which
    // is the earliest point the inconsistency can be caught.
    const jobId = 'job-unknown-trace'
    const missing = newId('tr_')

    // One delivery, not two: calling the handler again to inspect its rejection would run
    // the job a second time and make every count below wrong.
    const outcome = await deliver(jobId, missing).then(
      () => ({ threw: false }),
      () => ({ threw: true }),
    )
    expect(outcome.threw).toBe(true)

    // Reporting is not handling (ADR-0007): the tracker is told AND the job is failed, so
    // the queue retries it rather than marking it done.
    expect(reporter.reports).toHaveLength(1)
    expect(reporter.reports[0]?.requestId).toBe(REQUEST_ID)
    expect(reporter.reports[0]?.context).toMatchObject({ queue: RECORD_EVALUATION, job_id: jobId })
  })

  test('a failure DURING the work leaves a failed attempt row carrying the cause', async () => {
    /**
     * The reason `started` is written before the work rather than the outcome after it: an
     * attempt that never reaches an end state is visible as exactly that — a worker that
     * died mid-job — and one that failed says why.
     *
     * The trace update is broken while the ledger's writes go through the real handle,
     * because those are the two halves that must not be confused: the job's WORK failing
     * has to be recordable, and it is only recordable while the ledger still works.
     */
    const jobId = 'job-work-fails'
    // `Object.create` rather than a spread: Drizzle's methods live on the prototype, so a
    // spread produces an object with no `insert` at all and the test would fail for the
    // wrong reason.
    const brokenDb: Database = Object.assign(Object.create(db) as Database, {
      update: ((table: unknown) =>
        table === schema.traces
          ? {
              set: () => {
                throw new Error('the trace update blew up')
              },
            }
          : db.update(table as never)) as never,
    })

    const outcome = await createRecordEvaluationHandler({
      db: brokenDb,
      clock: createFixedClock(),
      errorReporter: reporter,
      logger: pino({ level: 'silent' }),
    })({
      jobId,
      queue: RECORD_EVALUATION,
      payload: { trace_id: TRACE, request_id: REQUEST_ID },
    }).then(
      () => undefined,
      (error: unknown) => error as Error,
    )

    // The CAUSE propagates, so the queue's retry decision is made on the real failure.
    expect(outcome?.message).toBe('the trace update blew up')

    const attempts = await attemptsOf(jobId)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('failed')
    expect(attempts[0]?.error).toBe('the trace update blew up')
    expect(attempts[0]?.finishedAt).not.toBeNull()

    expect(reporter.reports).toHaveLength(1)
    // And the work did NOT happen, so the retry has something to do.
    expect((await traceRow()).recordedAt).toBeNull()
  })
})
