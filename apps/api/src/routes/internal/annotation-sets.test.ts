import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ANNOTATION_SET_MAX_SIZE, errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { metrics, trace } from '@opentelemetry/api'
import { and, asc, eq, inArray } from 'drizzle-orm'
import { createFixedClock, type FixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { createAuth } from '../../auth.ts'
import { loadConfig } from '../../config.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { ACTIVE_ORG_HEADER } from '../../middleware/session.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * CURATING ANNOTATION SETS, against a real Postgres (ADR-0079…0083, ADR-0086).
 *
 * The claims that need a database rather than a fake: what each picker actually returns, that
 * the snapshot is append-only by GRANT (SQLSTATE 42501, a Postgres answer), that one dictator
 * per set is the database's rule and not the service's, and that the audit event carries no
 * trace ids — which is a claim about a row, read back out.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the annotation-sets integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

const ORG = newId('org_')
const OTHER_ORG = newId('org_')
const tag = ORG.slice(-8).toLowerCase()

const PANEL = newId('pnl_')
const VERSION = newId('pnv_')
const OTHER_PANEL = newId('pnl_')
const OTHER_VERSION = newId('pnv_')

const ENGINEER = `curate-engineer-${tag}@labelloop.test`
const ADMIN = `curate-admin-${tag}@labelloop.test`
const ANNOTATOR = `curate-annotator-${tag}@labelloop.test`
const SECOND = `curate-second-${tag}@labelloop.test`
const GUEST = `curate-guest-${tag}@labelloop.test`
const STRANGER = `curate-stranger-${tag}@labelloop.test`
const EMAILS = [ENGINEER, ADMIN, ANNOTATOR, SECOND, GUEST, STRANGER]
const PASSWORD = 'localdev-password'

/** Enough that `latest_n` and `earliest_n` pick disjoint halves at the sizes used below. */
const TRACES = 40

let db: Database
let auth: ReturnType<typeof createAuth>
let clock: FixedClock

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

const app = () =>
  createApp({
    config,
    clock,
    errorReporter: createRecordingErrorReporter(),
    db,
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock,
      tracer: noopTracer,
      meter: noopMeter,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: noopMeter,
    auth,
    rateLimitStore: createMemoryRateLimitStore(),
    modelProvider: createFakeProvider(),
    catalogue: fakeCatalogue(),
  })

const dropFixtures = async () => {
  await db.delete(schema.orgs).where(inArray(schema.orgs.id, [ORG, OTHER_ORG]))
  await db.delete(schema.user).where(inArray(schema.user.email, EMAILS))
}

const post = (path: string, body: unknown) =>
  app().request(`http://localhost/internal/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const cookies = new Map<string, string>()

const signIn = async (email: string): Promise<string> => {
  const cached = cookies.get(email)
  if (cached !== undefined) return cached
  const response = await post('sign-in/email', { email, password: PASSWORD })
  expect(response.status).toBe(200)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  cookies.set(email, cookie)
  return cookie
}

const userId = async (email: string): Promise<string> => {
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  if (row === undefined) throw new Error(`no user for ${email}`)
  return row.id
}

const call = async (
  email: string,
  method: string,
  path: string,
  { body, org = ORG }: { body?: unknown; org?: string } = {},
) => {
  const response = await app().request(`http://localhost/internal${path}`, {
    method,
    headers: {
      cookie: await signIn(email),
      [ACTIVE_ORG_HEADER]: org,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const codeOf = (body: Record<string, unknown>) => errorEnvelopeSchema.safeParse(body).data?.error

/** Drizzle wraps a driver error, so the SQLSTATE is on the CAUSE, not on what it threw. */
const sqlState = (error: unknown): string | undefined => {
  const wrapped = error as { code?: string; cause?: { code?: string } }
  return wrapped?.cause?.code ?? wrapped?.code
}

const slug = `curate-${tag}`

/** Create a set and return its id, failing loudly rather than returning a bad one. */
const createSet = async (name: string, pick: Record<string, unknown>, email = ENGINEER) => {
  const { status, body } = await call(email, 'POST', `/panels/${slug}/annotation-sets`, {
    body: { name, ...pick },
  })
  expect(status).toBe(201)
  return (body as { data: { id: string; size: number } }).data
}

const membersOf = (setId: string) =>
  db
    .select({
      traceId: schema.annotationSetTraces.traceId,
      strategy: schema.annotationSetTraces.strategy,
      addedAt: schema.annotationSetTraces.addedAt,
    })
    .from(schema.annotationSetTraces)
    .where(eq(schema.annotationSetTraces.annotationSetId, setId))
    .orderBy(asc(schema.annotationSetTraces.addedAt))

const traceRows = (panelId: string, panelVersionId: string, count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: newId('tr_'),
    orgId: panelId === OTHER_PANEL ? OTHER_ORG : ORG,
    panelId,
    panelVersionId,
    requestId: `${prefix}${index}`.padEnd(32, '0').slice(0, 32),
    // Spread across a minute so `latest_n` and `earliest_n` have an order to find.
    createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 60_000),
    input: [{ role: 'user', content: `question ${index}` }],
    output: `answer ${index}`,
    complete: true,
    threshold: 0.5,
  }))

let traceIds: string[] = []

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  clock = createFixedClock(Date.parse('2026-09-21T12:00:00Z'))
  auth = createAuth(db, config)
  await dropFixtures()

  await db.insert(schema.orgs).values([
    { id: ORG, slug: `curate-org-${tag}`, name: 'Curate org' },
    { id: OTHER_ORG, slug: `curate-other-${tag}`, name: 'Somebody else' },
  ])
  for (const email of EMAILS) {
    expect((await post('sign-up/email', { email, password: PASSWORD, name: 'Test' })).status).toBe(
      200,
    )
  }
  await db.insert(schema.orgMembers).values([
    { orgId: ORG, userId: await userId(ENGINEER), role: 'engineer' },
    { orgId: ORG, userId: await userId(ADMIN), role: 'admin' },
    { orgId: ORG, userId: await userId(ANNOTATOR), role: 'annotator' },
    { orgId: ORG, userId: await userId(SECOND), role: 'annotator' },
    { orgId: ORG, userId: await userId(GUEST), role: 'guest_expert' },
    { orgId: OTHER_ORG, userId: await userId(STRANGER), role: 'admin' },
  ])
  await db.insert(schema.panels).values([
    { id: PANEL, orgId: ORG, slug, name: 'Curated panel' },
    { id: OTHER_PANEL, orgId: OTHER_ORG, slug: `theirs-${tag}`, name: 'Their panel' },
  ])
  await db.insert(schema.panelVersions).values([
    { id: VERSION, panelId: PANEL, version: 1, threshold: 0.5 },
    { id: OTHER_VERSION, panelId: OTHER_PANEL, version: 1, threshold: 0.5 },
  ])
  const rows = [
    ...traceRows(PANEL, VERSION, TRACES, 'a'),
    ...traceRows(OTHER_PANEL, OTHER_VERSION, 5, 'c'),
  ]
  await db.insert(schema.traces).values(rows)
  traceIds = rows.filter((row) => row.panelId === PANEL).map((row) => row.id)
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

describe('each picker returns what it says (ADR-0080)', () => {
  test('latest_n takes the newest, earliest_n the oldest, and they do not overlap', async () => {
    const latest = await createSet('Latest ten', { strategy: 'latest_n', size: 10 })
    const earliest = await createSet('Earliest ten', { strategy: 'earliest_n', size: 10 })

    const latestIds = (await membersOf(latest.id)).map((row) => row.traceId).sort()
    const earliestIds = (await membersOf(earliest.id)).map((row) => row.traceId).sort()

    expect(latestIds).toEqual([...traceIds].slice(-10).sort())
    expect(earliestIds).toEqual([...traceIds].slice(0, 10).sort())
    expect(latestIds.filter((id) => earliestIds.includes(id))).toEqual([])
  })

  test('random_n takes that many, all from this panel', async () => {
    const set = await createSet('Random twelve', { strategy: 'random_n', size: 12 })
    const rows = await membersOf(set.id)
    expect(rows).toHaveLength(12)
    expect(rows.every((row) => traceIds.includes(row.traceId))).toBe(true)
  })

  test('manual takes exactly what was named', async () => {
    const picked = traceIds.slice(3, 9)
    const set = await createSet('Six by hand', { strategy: 'manual', trace_ids: picked })
    expect((await membersOf(set.id)).map((row) => row.traceId).sort()).toEqual([...picked].sort())
  })

  test('the strategy is recorded on every membership row', async () => {
    const set = await createSet('Strategy recorded', { strategy: 'earliest_n', size: 4 })
    expect((await membersOf(set.id)).map((row) => row.strategy)).toEqual([
      'earliest_n',
      'earliest_n',
      'earliest_n',
      'earliest_n',
    ])
  })

  test('a manual pick naming a trace outside the panel is a 422 and adds NOTHING', async () => {
    const outside = newId('tr_')
    const { status, body } = await call(ENGINEER, 'POST', `/panels/${slug}/annotation-sets`, {
      body: { name: 'Should not exist', strategy: 'manual', trace_ids: [traceIds[0], outside] },
    })
    expect(status).toBe(422)
    expect(codeOf(body)?.code).toBe('VALIDATION_ERROR')
    const [row] = await db
      .select({ id: schema.annotationSets.id })
      .from(schema.annotationSets)
      .where(
        and(
          eq(schema.annotationSets.panelId, PANEL),
          eq(schema.annotationSets.name, 'Should not exist'),
        ),
      )
    expect(row).toBeUndefined()
  })
})

describe('the snapshot only grows (ADR-0080)', () => {
  test('a top-up appends NEW traces, with a later added_at', async () => {
    const set = await createSet('Top me up', { strategy: 'earliest_n', size: 5 })
    clock.advance(60_000)
    const { status, body } = await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/top-up`, {
      body: { strategy: 'earliest_n', size: 5 },
    })
    expect(status).toBe(200)
    expect((body as { data: { added: number; size: number } }).data).toEqual({ added: 5, size: 10 })

    const rows = await membersOf(set.id)
    expect(rows).toHaveLength(10)
    // The picker EXCLUDES what the set already holds, so a second earliest-5 is the next five.
    expect(new Set(rows.map((row) => row.traceId)).size).toBe(10)
    const stamps = rows.map((row) => row.addedAt.getTime())
    expect(Math.max(...stamps)).toBeGreaterThan(Math.min(...stamps))
  })

  test('a top-up re-picking a trace by hand adds nothing', async () => {
    const set = await createSet('Nothing new', {
      strategy: 'manual',
      trace_ids: traceIds.slice(0, 3),
    })
    const { status, body } = await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/top-up`, {
      body: { strategy: 'manual', trace_ids: traceIds.slice(0, 3) },
    })
    expect(status).toBe(200)
    expect((body as { data: { added: number; size: number } }).data).toEqual({ added: 0, size: 3 })
    expect(await membersOf(set.id)).toHaveLength(3)
  })

  test('membership is append-only BY GRANT — the app role cannot UPDATE or DELETE it', async () => {
    const set = await createSet('Append only', { strategy: 'latest_n', size: 2 })
    // 42501 is insufficient_privilege: Postgres refusing, not application code choosing not to.
    const updated = await db
      .update(schema.annotationSetTraces)
      .set({ strategy: 'manual' })
      .where(eq(schema.annotationSetTraces.annotationSetId, set.id))
      .catch((error: unknown) => error)
    expect(sqlState(updated)).toBe('42501')

    const deleted = await db
      .delete(schema.annotationSetTraces)
      .where(eq(schema.annotationSetTraces.annotationSetId, set.id))
      .catch((error: unknown) => error)
    expect(sqlState(deleted)).toBe('42501')

    expect(await membersOf(set.id)).toHaveLength(2)
  })

  test('the cap holds however many top-ups it takes (ADR-0082)', async () => {
    expect(ANNOTATION_SET_MAX_SIZE).toBe(250)
    // The panel has 40 traces, so a size-250 ask takes every one of them and a top-up finds
    // nothing left — which is the same code path the cap runs, exercised at a testable size.
    const set = await createSet('All of them', {
      strategy: 'latest_n',
      size: ANNOTATION_SET_MAX_SIZE,
    })
    expect(set.size).toBe(TRACES)
    const { body } = await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/top-up`, {
      body: { strategy: 'latest_n', size: 10 },
    })
    expect((body as { data: { added: number } }).data.added).toBe(0)
  })

  test('a size over the cap is refused by the contract, before anything is written', async () => {
    const { status, body } = await call(ENGINEER, 'POST', `/panels/${slug}/annotation-sets`, {
      body: { name: 'Too big', strategy: 'random_n', size: ANNOTATION_SET_MAX_SIZE + 1 },
    })
    expect(status).toBe(422)
    expect(codeOf(body)?.code).toBe('VALIDATION_ERROR')
  })
})

describe('a set is named once per panel', () => {
  test('a duplicate name is a 422, case-insensitively', async () => {
    await createSet('Refund replies', { strategy: 'latest_n', size: 2 })
    const { status, body } = await call(ENGINEER, 'POST', `/panels/${slug}/annotation-sets`, {
      body: { name: 'refund REPLIES', strategy: 'latest_n', size: 2 },
    })
    expect(status).toBe(422)
    expect(codeOf(body)?.message).toContain('already has an annotation set with that name')
  })
})

describe('the audit event says what happened and not what was chosen', () => {
  test('it carries the strategy and the count, and NEVER a trace id', async () => {
    const set = await createSet('Audited', { strategy: 'manual', trace_ids: traceIds.slice(0, 4) })
    const [event] = await db
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, set.id))

    expect(event?.action).toBe('annotation_set.created')
    expect(event?.data).toMatchObject({ strategy: 'manual', requested: 4, added: 4 })
    // The log has no UPDATE and no DELETE, so what goes in is permanent. A selection copied
    // into it could never be trimmed, and the strategy plus the count answer the question.
    const serialised = JSON.stringify(event?.data)
    for (const traceId of traceIds.slice(0, 4)) expect(serialised).not.toContain(traceId)
  })
})

describe('assignment (ADR-0081, ADR-0086, open questions 3 and 6)', () => {
  const assign = (setId: string, annotators: unknown[], email = ENGINEER) =>
    call(email, 'PUT', `/annotation-sets/${setId}/annotators`, { body: { annotators } })

  const rowsFor = (setId: string) =>
    db
      .select({
        userId: schema.annotationSetAnnotators.userId,
        isDictator: schema.annotationSetAnnotators.isDictator,
        unassignedAt: schema.annotationSetAnnotators.unassignedAt,
      })
      .from(schema.annotationSetAnnotators)
      .where(eq(schema.annotationSetAnnotators.annotationSetId, setId))

  test('one annotator needs no dictator', async () => {
    const set = await createSet('Solo', { strategy: 'latest_n', size: 2 })
    const { status } = await assign(set.id, [{ user_id: await userId(ANNOTATOR) }])
    expect(status).toBe(200)
  })

  test('TWO annotators and no dictator is refused', async () => {
    const set = await createSet('Two, no dictator', { strategy: 'latest_n', size: 2 })
    const { status, body } = await assign(set.id, [
      { user_id: await userId(ANNOTATOR) },
      { user_id: await userId(SECOND) },
    ])
    expect(status).toBe(422)
    expect(codeOf(body)?.message).toContain('need a dictator')
    expect(await rowsFor(set.id)).toEqual([])
  })

  test('a body naming TWO dictators is refused by the contract', async () => {
    const set = await createSet('Two dictators', { strategy: 'latest_n', size: 2 })
    const { status } = await assign(set.id, [
      { user_id: await userId(ANNOTATOR), is_dictator: true },
      { user_id: await userId(SECOND), is_dictator: true },
    ])
    expect(status).toBe(422)
  })

  test('a SECOND live dictator is refused by the DATABASE, not only by the service', async () => {
    const set = await createSet('Database says no', { strategy: 'latest_n', size: 2 })
    await assign(set.id, [
      { user_id: await userId(ANNOTATOR), is_dictator: true },
      { user_id: await userId(SECOND) },
    ])
    const failure = await db
      .insert(schema.annotationSetAnnotators)
      .values({
        annotationSetId: set.id,
        userId: await userId(ENGINEER),
        isDictator: true,
        assignedBy: await userId(ENGINEER),
      })
      .catch((error: unknown) => error)
    // 23505 is unique_violation: `annotation_set_one_dictator_key`, a partial index over the
    // CURRENTLY assigned. The service never issues this; the database is the guarantee.
    expect(sqlState(failure)).toBe('23505')
  })

  test('unassigning KEEPS the row and stamps it (open question 3)', async () => {
    const set = await createSet('Stamped, not deleted', { strategy: 'latest_n', size: 2 })
    const first = await userId(ANNOTATOR)
    await assign(set.id, [{ user_id: first }])
    const { status, body } = await assign(set.id, [])
    expect(status).toBe(200)
    expect((body as { data: { unassigned: number } }).data.unassigned).toBe(1)

    const rows = await rowsFor(set.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.userId).toBe(first)
    expect(rows[0]?.unassignedAt).not.toBeNull()
  })

  test('unassigning the dictator is refused unless the same call names another', async () => {
    const set = await createSet('Dictator handover', { strategy: 'latest_n', size: 2 })
    const one = await userId(ANNOTATOR)
    const two = await userId(SECOND)
    await assign(set.id, [{ user_id: one, is_dictator: true }, { user_id: two }])

    // Dropping the dictator and leaving two people: refused.
    const refused = await assign(set.id, [{ user_id: two }, { user_id: await userId(ENGINEER) }])
    expect(refused.status).toBe(422)
    expect(codeOf(refused.body)?.message).toContain('need a dictator')

    // The same call naming another: accepted, and the role moves.
    const accepted = await assign(set.id, [
      { user_id: two, is_dictator: true },
      { user_id: await userId(ENGINEER) },
    ])
    expect(accepted.status).toBe(200)
    const live = (await rowsFor(set.id)).filter((row) => row.unassignedAt === null)
    expect(live.filter((row) => row.isDictator).map((row) => row.userId)).toEqual([two])
  })

  test('a DEVELOPER is an assignable person (M5 decision 3, revised)', async () => {
    const set = await createSet('Developers annotate too', { strategy: 'latest_n', size: 2 })
    const { status } = await assign(set.id, [{ user_id: await userId(ENGINEER) }])
    expect(status).toBe(200)
  })

  test('somebody outside the org cannot be assigned', async () => {
    const set = await createSet('Not yours', { strategy: 'latest_n', size: 2 })
    const { status, body } = await assign(set.id, [{ user_id: await userId(STRANGER) }])
    expect(status).toBe(422)
    expect(codeOf(body)?.message).toContain('cannot be assigned work')
  })

  test('a guest expert cannot be assigned — they may not annotate at all (ADR-0072)', async () => {
    const set = await createSet('No guests yet', { strategy: 'latest_n', size: 2 })
    const { status } = await assign(set.id, [{ user_id: await userId(GUEST) }])
    expect(status).toBe(422)
  })
})

describe('archiving is a stamp (ADR-0086)', () => {
  test('it records when, and says nothing about whether the set is done', async () => {
    const set = await createSet('Put away', { strategy: 'latest_n', size: 3 })
    // Nobody has answered anything, so the set is plainly NOT done — and archiving it works.
    const { status, body } = await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/archive`)
    expect(status).toBe(200)
    expect((body as { data: { archived_at: string } }).data.archived_at).toBeString()

    const [row] = await db
      .select({ archivedAt: schema.annotationSets.archivedAt })
      .from(schema.annotationSets)
      .where(eq(schema.annotationSets.id, set.id))
    expect(row?.archivedAt).not.toBeNull()
    // There is no `completed_at` to have been written, which is the decision itself.
    expect(Object.keys(row ?? {})).toEqual(['archivedAt'])
  })

  test('an archived set is still LISTED — an archive the server hides is a delete', async () => {
    const set = await createSet('Still listed', { strategy: 'latest_n', size: 2 })
    await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/archive`)
    const { body } = await call(ENGINEER, 'GET', `/panels/${slug}/annotation-sets`)
    const listed = (body as { data: { sets: { id: string; archived_at: string | null }[] } }).data
      .sets
    expect(listed.find((row) => row.id === set.id)?.archived_at).toBeString()
  })

  test('an archived set cannot be topped up or reassigned', async () => {
    const set = await createSet('Closed for changes', { strategy: 'latest_n', size: 2 })
    await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/archive`)

    const toppedUp = await call(ENGINEER, 'POST', `/annotation-sets/${set.id}/top-up`, {
      body: { strategy: 'latest_n', size: 1 },
    })
    expect(toppedUp.status).toBe(422)
    const assigned = await call(ENGINEER, 'PUT', `/annotation-sets/${set.id}/annotators`, {
      body: { annotators: [{ user_id: await userId(ANNOTATOR) }] },
    })
    expect(assigned.status).toBe(422)
  })
})

describe('the staff read (ADR-0084)', () => {
  /**
   * Built here rather than reused from another test's fixtures, because this is the one claim
   * that needs TWO people answering the SAME traces differently — which is what the grid
   * exists to show and what the dictator rule exists to settle.
   */
  const setup = async (name: string) => {
    const set = await createSet(name, { strategy: 'manual', trace_ids: traceIds.slice(10, 13) })
    const one = await userId(ANNOTATOR)
    const two = await userId(SECOND)
    await call(ENGINEER, 'PUT', `/annotation-sets/${set.id}/annotators`, {
      body: {
        annotators: [{ user_id: one, is_dictator: true }, { user_id: two }],
      },
    })
    return { setId: set.id, one, two }
  }

  const answer = (email: string, setId: string, itemId: string, outcome: string, note?: string) =>
    call(email, 'POST', `/annotate/sets/${setId}/annotations`, {
      body: { item_id: itemId, outcome, ...(note === undefined ? {} : { note }) },
    })

  const read = async (setId: string, email = ENGINEER) => {
    const { status, body } = await call(email, 'GET', `/annotation-sets/${setId}`)
    return { status, data: (body as { data?: Record<string, never> }).data, body }
  }

  test('it returns EVERY annotator’s answer, and marks the one that counts', async () => {
    const { setId, one, two } = await setup('Two answers')
    const [first] = traceIds.slice(10, 11)
    // They disagree about the same trace, which is the case the whole grid exists for.
    expect((await answer(ANNOTATOR, setId, first ?? '', 'acceptable')).status).toBe(201)
    expect(
      (await answer(SECOND, setId, first ?? '', 'not_acceptable', 'Refuses a valid refund.'))
        .status,
    ).toBe(201)

    const { status, data } = await read(setId)
    expect(status).toBe(200)
    const detail = data as unknown as {
      size: number
      done: boolean
      annotators: { user_id: string; is_dictator: boolean; answered: number }[]
      traces: {
        trace_id: string
        answers: { annotator_id: string; outcome: string; note: string | null }[]
        counting: { outcome: string; annotator_id?: string; annotatorId?: string } | null
      }[]
    }
    expect(detail.size).toBe(3)
    expect(detail.done).toBe(false)
    expect(detail.annotators.map((row) => row.user_id).sort()).toEqual([one, two].sort())
    expect(detail.annotators.find((row) => row.user_id === one)?.is_dictator).toBe(true)

    const row = detail.traces.find((trace) => trace.trace_id === first)
    expect(row?.answers).toHaveLength(2)
    expect(row?.answers.map((entry) => entry.outcome).sort()).toEqual([
      'acceptable',
      'not_acceptable',
    ])
    // The NOTE reaches staff. ADR-0067 is about what reaches the ANNOTATOR; reading a panel's
    // traces is `trace: ['read']` territory, which staff have.
    expect(row?.answers.find((entry) => entry.annotator_id === two)?.note).toBe(
      'Refuses a valid refund.',
    )
    // THE DICTATOR'S IS THE ONE THAT COUNTS (ADR-0081) — computed by the server, so this screen
    // and M6 cannot disagree about which answer won.
    expect(row?.counting?.outcome).toBe('acceptable')
  })

  test('an UNANSWERED trace carries no answers and nothing counting', async () => {
    const { setId } = await setup('Mostly untouched')
    const detail = (await read(setId)).data as unknown as {
      traces: { answers: unknown[]; counting: unknown }[]
    }
    expect(detail.traces).toHaveLength(3)
    expect(detail.traces.every((trace) => trace.answers.length === 0)).toBe(true)
    expect(detail.traces.every((trace) => trace.counting === null)).toBe(true)
  })

  test('an UNASSIGNED annotator stays listed, marked, with their answers intact', async () => {
    const { setId, one, two } = await setup('Somebody left')
    const [first] = traceIds.slice(10, 11)
    expect((await answer(SECOND, setId, first ?? '', 'acceptable')).status).toBe(201)

    // Unassign them — the same call keeps the dictator, which is what the server requires.
    const put = await call(ENGINEER, 'PUT', `/annotation-sets/${setId}/annotators`, {
      body: { annotators: [{ user_id: one, is_dictator: true }] },
    })
    expect(put.status).toBe(200)

    const detail = (await read(setId)).data as unknown as {
      annotators: { user_id: string; unassigned_at: string | null; answered: number }[]
      traces: { answers: { annotator_id: string }[] }[]
    }
    const gone = detail.annotators.find((row) => row.user_id === two)
    expect(gone?.unassigned_at).toBeString()
    expect(gone?.answered).toBe(1)
    // The work happened, so the answer is still on the grid.
    expect(detail.traces.some((trace) => trace.answers.some((a) => a.annotator_id === two))).toBe(
      true,
    )
  })

  test('a CHANGED MIND shows the latest answer and says how many it replaced', async () => {
    const { setId } = await setup('Second thoughts')
    const [first] = traceIds.slice(10, 11)
    expect((await answer(ANNOTATOR, setId, first ?? '', 'acceptable')).status).toBe(201)
    expect(
      (await answer(ANNOTATOR, setId, first ?? '', 'not_acceptable', 'Caught it on re-reading.'))
        .status,
    ).toBe(201)

    const detail = (await read(setId)).data as unknown as {
      traces: { trace_id: string; answers: { outcome: string; revisions: number }[] }[]
    }
    const row = detail.traces.find((trace) => trace.trace_id === first)
    // ONE entry per person — the latest — with the count of what it replaced. The table is
    // append-only, so the earlier rows are still there; this screen shows the current answer
    // and says plainly that it is not the first.
    expect(row?.answers).toHaveLength(1)
    expect(row?.answers[0]?.outcome).toBe('not_acceptable')
    expect(row?.answers[0]?.revisions).toBe(1)
  })

  test('an ANNOTATOR calling the staff read is FORBIDDEN', async () => {
    const { setId } = await setup('Not for annotators')
    // They are ASSIGNED to this very set and can annotate it — and still cannot read what
    // anybody else said. Knowing another annotator's answer is the strongest anchor there is
    // (ADR-0081), which is why curating is its own capability (ADR-0083).
    const { status, body } = await read(setId, ANNOTATOR)
    expect(status).toBe(403)
    expect(codeOf(body)?.code).toBe('FORBIDDEN')
  })

  test('a set in another org is NOT_FOUND', async () => {
    const { setId } = await setup('Mine')
    const { status, body } = await call(STRANGER, 'GET', `/annotation-sets/${setId}`, {
      org: OTHER_ORG,
    })
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
  })

  test('the LIST carries `done`, derived the same way the set detail derives it', async () => {
    const { setId } = await setup('Finish me')
    for (const traceId of traceIds.slice(10, 13)) {
      expect((await answer(ANNOTATOR, setId, traceId, 'acceptable')).status).toBe(201)
      expect((await answer(SECOND, setId, traceId, 'acceptable')).status).toBe(201)
    }
    const listed = await call(ENGINEER, 'GET', `/panels/${slug}/annotation-sets`)
    const sets = (listed.body as { data: { sets: { id: string; done: boolean }[] } }).data.sets
    expect(sets.find((row) => row.id === setId)?.done).toBe(true)
    expect(((await read(setId)).data as unknown as { done: boolean }).done).toBe(true)
  })
})

describe('org scoping (ADR-0057)', () => {
  test("another org's set is NOT_FOUND, not FORBIDDEN", async () => {
    const set = await createSet('Mine alone', { strategy: 'latest_n', size: 2 })
    const { status, body } = await call(STRANGER, 'POST', `/annotation-sets/${set.id}/archive`, {
      org: OTHER_ORG,
    })
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
  })

  test("another org's panel is NOT_FOUND", async () => {
    const { status } = await call(STRANGER, 'GET', `/panels/${slug}/annotation-sets`, {
      org: OTHER_ORG,
    })
    expect(status).toBe(404)
  })

  test('an ANNOTATOR cannot curate at all (ADR-0083)', async () => {
    const { status, body } = await call(ANNOTATOR, 'GET', `/panels/${slug}/annotation-sets`)
    expect(status).toBe(403)
    expect(codeOf(body)?.code).toBe('FORBIDDEN')
  })

  test('an ADMIN can curate', async () => {
    const { status } = await call(ADMIN, 'GET', `/panels/${slug}/annotation-sets`)
    expect(status).toBe(200)
  })
})
