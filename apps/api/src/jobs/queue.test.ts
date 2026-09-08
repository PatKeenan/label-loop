import { afterAll, describe, expect, test } from 'bun:test'
import { QUEUES } from '@labelloop/db'
import { ephemeralQueue } from '@labelloop/db/test-support'
import { createPgBossQueue, type JobDelivery } from './index.ts'
import { RECORD_EVALUATION } from './record-evaluation.ts'

/**
 * The queue adapter against a real pg-boss and a real Postgres — the seam M0 exists to
 * de-risk (the plan's D-A puts pg-boss among the three Bun-sensitive dependencies, and
 * finding out at M3 that it does not work here is the failure this milestone prevents).
 *
 * The handler's behaviour is asserted separately, without a poller, in
 * `record-evaluation.test.ts`. What is asserted HERE is only what a fake cannot tell you:
 * that a job survives the round trip through Postgres, that the app role's credential is
 * enough to work it, and that shutdown drains rather than severs.
 *
 * The round trip runs on a queue of this test's own (`ephemeralQueue`), NOT on
 * `record-evaluation`. A declared queue is shared with every pg-boss client pointed at the
 * same database — on a developer machine, the composed stack's `api` container — and a
 * test that waits for its own worker to be handed the job is then asserting that it won a
 * race it has no way to win reliably. The helper's own comment has the full account. What
 * matters here is that the isolation is of the QUEUE and nothing else: this is still the
 * real adapter, the real pg-boss, the real Postgres and the app role's credential.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the queue tests need a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const errors: unknown[] = []

const queue = createPgBossQueue({
  url: DATABASE_URL,
  poolMax: 2,
  onError: (error) => errors.push(error),
})

await queue.start()

/**
 * Created before the suite so `work()` has something to subscribe to, and dropped after
 * it. The migrator creates it, exactly as `db:migrate` creates the declared queues.
 */
const roundTrip = await ephemeralQueue('queue-adapter-round-trip')

afterAll(async () => {
  // Stop first, drop second: dropping a queue out from under a running worker is a race of
  // its own, and the point of this file is not to introduce one.
  await queue.stop()
  await roundTrip.drop()
})

/** Polling is the delivery mechanism, so waiting is the test's job, not a code smell. */
const waitFor = async <T>(read: () => T | undefined, timeoutMs = 15_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error('timed out waiting for the job to be delivered')
    await Bun.sleep(50)
  }
}

describe('the pg-boss adapter', () => {
  test('start() succeeded on a schema the app role cannot install', () => {
    // The assertion is that the line above this describe did not throw. `migrate: false`
    // and `createSchema: false` mean pg-boss REFUSES rather than installing, so a green
    // start here is evidence `db:migrate` did the install as the migrator (ADR-0017's
    // companion rule in CONVENTIONS.md "Data rules").
    expect(errors).toEqual([])
  })

  test('check() passes when every declared queue is installed', async () => {
    expect(QUEUES).toContain(RECORD_EVALUATION)
    await queue.check()
  })

  test('a job survives the round trip through Postgres, payload intact', async () => {
    const delivered: JobDelivery[] = []
    await queue.work(roundTrip.name, async (delivery) => {
      delivered.push(delivery)
    })

    const traceId = `tr_roundtrip_${Date.now()}`
    const requestId = 'cd'.repeat(16)
    const jobId = await queue.send(roundTrip.name, {
      trace_id: traceId,
      request_id: requestId,
    })
    expect(jobId).not.toBeNull()

    const received = await waitFor(() =>
      delivered.find((delivery) => delivery.payload.trace_id === traceId),
    )
    expect(received.jobId).toBe(jobId as string)
    expect(received.queue).toBe(roundTrip.name)
    // Both ids arrive, which is what makes a job's log lines findable from the request that
    // created it and from the evaluation it is about (ADR-0010).
    expect(received.payload).toEqual({ trace_id: traceId, request_id: requestId })
  }, 30_000)

  test('nothing failed out of band while all of that happened', () => {
    // pg-boss reports maintenance and polling failures on an event emitter rather than by
    // rejecting a promise, so a suite that only awaits its calls can pass while the
    // supervisor has been failing every tick.
    expect(errors).toEqual([])
  })
})
