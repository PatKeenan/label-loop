import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { ANNOTATION_FLOOR, errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { metrics, trace } from '@opentelemetry/api'
import { and, eq, inArray } from 'drizzle-orm'
import { createFixedClock, type FixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { createAuth } from '../../auth.ts'
import { loadConfig } from '../../config.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { ACTIVE_ORG_HEADER } from '../../middleware/session.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import { nextItem, setProgress } from '../../services/annotation-queue.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * THE ANNOTATION QUEUE, against a real Postgres and a real better-auth session (ADR-0066,
 * ADR-0079, ADR-0081).
 *
 * The claims worth a database: what the payload does NOT contain (ADR-0067, ADR-0077); that
 * the pool is an ASSIGNED SET and a set you are not on is NOT_FOUND; that EVERYONE assigned
 * gets the whole set and nobody is served a trace twice; and that the table cannot be edited
 * afterwards — which is a grant, so only Postgres can answer it.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the annotate integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

const ORG = newId('org_')
const OTHER_ORG = newId('org_')
const tag = ORG.slice(-8).toLowerCase()

const OPEN_PANEL = newId('pnl_')
const OPEN_VERSION = newId('pnv_')
const LOCKED_PANEL = newId('pnl_')
const LOCKED_VERSION = newId('pnv_')
const OTHER_PANEL = newId('pnl_')
const OTHER_VERSION = newId('pnv_')

/**
 * FOUR SETS, because the rules they exercise are different.
 *
 * `SET` holds the open panel's whole pool, so the drawing tests have somewhere to draw from.
 * `SMALL_SET` holds three traces, so "both annotators get all of it" is a finite assertion
 * rather than a probability. `LOCKED_SET` sits on a panel below the floor. `UNASSIGNED_SET`
 * exists so "a set you are not on" can be asked as a question rather than assumed.
 */
const SET = newId('aset_')
const SMALL_SET = newId('aset_')
const LOCKED_SET = newId('aset_')
const UNASSIGNED_SET = newId('aset_')
const OTHER_SET = newId('aset_')

const ANNOTATOR = `annotator-${tag}@labelloop.test`
const SECOND = `second-${tag}@labelloop.test`
const ENGINEER = `engineer-${tag}@labelloop.test`
const STRANGER = `stranger-${tag}@labelloop.test`
const EMAILS = [ANNOTATOR, SECOND, ENGINEER, STRANGER]
const PASSWORD = 'localdev-password'

/** One over the floor, so "the gate opens at 50" is tested at the boundary, not near it. */
const OPEN_TRACES = ANNOTATION_FLOOR + 1
const LOCKED_TRACES = ANNOTATION_FLOOR - 1

let smallTraceIds: string[] = []

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
  // Annotations RESTRICT the users they name, so they go before the accounts do; the org
  // cascade takes them with everything else it owns.
  await db.delete(schema.orgs).where(inArray(schema.orgs.id, [ORG, OTHER_ORG]))
  await db.delete(schema.user).where(inArray(schema.user.email, EMAILS))
}

const post = (path: string, body: unknown) =>
  app().request(`http://localhost/internal/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** Cached: better-auth hashes the password on every sign-in, and these tests call a lot. */
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

type Item = {
  state: 'item' | 'locked' | 'drained'
  item_id?: string
  input?: unknown
  output?: unknown
  reference?: unknown
  remaining?: number
  annotated?: number
  trace_count?: number
  previous_outcome?: string
}

const next = async (email: string, setId = SET, org = ORG) => {
  const { status, body } = await call(email, 'GET', `/annotate/sets/${setId}/next`, { org })
  return { status, data: (body as { data?: Item }).data, body }
}

const stepBack = async (email: string, setId = SET) => {
  const { status, body } = await call(email, 'GET', `/annotate/sets/${setId}/previous`)
  return { status, data: (body as { data?: Item }).data }
}

const answer = (email: string, itemId: string, outcome: string, note?: string, setId = SET) =>
  call(email, 'POST', `/annotate/sets/${setId}/annotations`, {
    body: { item_id: itemId, outcome, ...(note === undefined ? {} : { note }) },
  })

const codeOf = (body: Record<string, unknown>) => errorEnvelopeSchema.safeParse(body).data?.error

/**
 * One person's rows on one trace, oldest first.
 *
 * SCOPED TO THE PERSON, and that is not tidiness: the queue can serve ANNOTATOR a trace that
 * SECOND skipped, so an unscoped read returns their row too. Three assertions here counted all
 * of them and failed roughly one run in ten, which read as flakiness in the queue rather than
 * in the test.
 */
const annotationsOf = async (traceId: string, email: string) =>
  db
    .select()
    .from(schema.annotations)
    .where(
      and(
        eq(schema.annotations.traceId, traceId),
        eq(schema.annotations.annotatorId, await userId(email)),
      ),
    )
    .orderBy(schema.annotations.createdAt, schema.annotations.id)

const traceRows = (panelId: string, panelVersionId: string, count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => ({
    id: newId('tr_'),
    orgId: panelId === OTHER_PANEL ? OTHER_ORG : ORG,
    panelId,
    panelVersionId,
    requestId: `${prefix}${index}`.padEnd(32, '0').slice(0, 32),
    input: [{ role: 'user', content: `question ${index}` }],
    output: `answer ${index}`,
    reference: { policy: 'Refunds within 14 days.' },
    metadata: { conversation_id: `c_${index}` },
    complete: true,
    threshold: 0.5,
  }))

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  clock = createFixedClock(Date.parse('2026-09-20T12:00:00Z'))
  auth = createAuth(db, config)
  await dropFixtures()

  await db.insert(schema.orgs).values([
    { id: ORG, slug: `annotate-${tag}`, name: 'Annotate org' },
    { id: OTHER_ORG, slug: `other-${tag}`, name: 'Somebody else' },
  ])
  for (const email of EMAILS) {
    expect((await post('sign-up/email', { email, password: PASSWORD, name: 'Test' })).status).toBe(
      200,
    )
  }
  await db.insert(schema.orgMembers).values([
    { orgId: ORG, userId: await userId(ANNOTATOR), role: 'annotator' },
    { orgId: ORG, userId: await userId(SECOND), role: 'annotator' },
    { orgId: ORG, userId: await userId(ENGINEER), role: 'engineer' },
    { orgId: OTHER_ORG, userId: await userId(STRANGER), role: 'admin' },
  ])

  await db.insert(schema.panels).values([
    { id: OPEN_PANEL, orgId: ORG, slug: `open-${tag}`, name: 'Open panel' },
    { id: LOCKED_PANEL, orgId: ORG, slug: `locked-${tag}`, name: 'Locked panel' },
    { id: OTHER_PANEL, orgId: OTHER_ORG, slug: `theirs-${tag}`, name: 'Their panel' },
  ])
  await db.insert(schema.panelVersions).values([
    { id: OPEN_VERSION, panelId: OPEN_PANEL, version: 1, threshold: 0.5 },
    { id: LOCKED_VERSION, panelId: LOCKED_PANEL, version: 1, threshold: 0.5 },
    { id: OTHER_VERSION, panelId: OTHER_PANEL, version: 1, threshold: 0.5 },
  ])
  const openTraces = traceRows(OPEN_PANEL, OPEN_VERSION, OPEN_TRACES, 'a')
  const lockedTraces = traceRows(LOCKED_PANEL, LOCKED_VERSION, LOCKED_TRACES, 'b')
  const theirTraces = traceRows(OTHER_PANEL, OTHER_VERSION, OPEN_TRACES, 'c')
  await db.insert(schema.traces).values([...openTraces, ...lockedTraces, ...theirTraces])

  // The sets are inserted directly rather than through the curate routes: this file is about
  // what the QUEUE does with them, and going through HTTP would make every assertion here
  // depend on a surface `annotation-sets.test.ts` already covers.
  const engineerId = await userId(ENGINEER)
  const strangerId = await userId(STRANGER)
  await db.insert(schema.annotationSets).values([
    { id: SET, orgId: ORG, panelId: OPEN_PANEL, name: 'Whole pool', createdBy: engineerId },
    { id: SMALL_SET, orgId: ORG, panelId: OPEN_PANEL, name: 'Three traces', createdBy: engineerId },
    { id: LOCKED_SET, orgId: ORG, panelId: LOCKED_PANEL, name: 'Too early', createdBy: engineerId },
    {
      id: UNASSIGNED_SET,
      orgId: ORG,
      panelId: OPEN_PANEL,
      name: 'Not yours',
      createdBy: engineerId,
    },
    {
      id: OTHER_SET,
      orgId: OTHER_ORG,
      panelId: OTHER_PANEL,
      name: 'Theirs',
      createdBy: strangerId,
    },
  ])
  smallTraceIds = openTraces.slice(0, 3).map((row) => row.id)
  await db.insert(schema.annotationSetTraces).values([
    ...openTraces.map((row) => ({
      annotationSetId: SET,
      traceId: row.id,
      strategy: 'random_n' as const,
      addedBy: engineerId,
    })),
    // A different picker, so `sampler` recording the MEMBERSHIP ROW rather than a constant is
    // visible in one assertion.
    ...smallTraceIds.map((traceId) => ({
      annotationSetId: SMALL_SET,
      traceId,
      strategy: 'manual' as const,
      addedBy: engineerId,
    })),
    ...lockedTraces.map((row) => ({
      annotationSetId: LOCKED_SET,
      traceId: row.id,
      strategy: 'latest_n' as const,
      addedBy: engineerId,
    })),
    ...openTraces.slice(0, 5).map((row) => ({
      annotationSetId: UNASSIGNED_SET,
      traceId: row.id,
      strategy: 'manual' as const,
      addedBy: engineerId,
    })),
    ...theirTraces.slice(0, 3).map((row) => ({
      annotationSetId: OTHER_SET,
      traceId: row.id,
      strategy: 'manual' as const,
      addedBy: strangerId,
    })),
  ])
  await db.insert(schema.annotationSetAnnotators).values([
    // Three on the big set, so "an engineer may annotate" is a real assignment (ADR-0084).
    {
      annotationSetId: SET,
      userId: await userId(ANNOTATOR),
      isDictator: true,
      assignedBy: engineerId,
    },
    { annotationSetId: SET, userId: await userId(SECOND), assignedBy: engineerId },
    { annotationSetId: SET, userId: engineerId, assignedBy: engineerId },
    {
      annotationSetId: SMALL_SET,
      userId: await userId(ANNOTATOR),
      isDictator: true,
      assignedBy: engineerId,
    },
    { annotationSetId: SMALL_SET, userId: await userId(SECOND), assignedBy: engineerId },
    {
      annotationSetId: LOCKED_SET,
      userId: await userId(ANNOTATOR),
      isDictator: true,
      assignedBy: engineerId,
    },
    { annotationSetId: LOCKED_SET, userId: await userId(SECOND), assignedBy: engineerId },
    { annotationSetId: OTHER_SET, userId: strangerId, assignedBy: strangerId },
  ])
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

describe('what an annotator is served (ADR-0067, ADR-0077)', () => {
  test('the payload carries the three roles and NOTHING else — asserted by key', async () => {
    const { status, data } = await next(ANNOTATOR)
    expect(status).toBe(200)
    expect(data?.state).toBe('item')
    // The absence IS the guarantee, so the assertion is the key set, not the values.
    expect(Object.keys(data ?? {}).sort()).toEqual([
      'annotated',
      'input',
      'item_id',
      'output',
      'reference',
      'remaining',
      'state',
    ])
    // Named individually as well, because a future field would have to be added to the list
    // above deliberately — and these are the ones that must never appear.
    for (const withheld of [
      'metadata',
      'trace_id',
      'passed',
      'score',
      'confidence',
      'verdict',
      'judges',
      'model',
      'served_by',
      'cost_usd',
      'key_name',
      'panel_version_id',
    ]) {
      expect(data).not.toHaveProperty(withheld)
    }
  })

  test('the roles arrive in the shapes they were sent in (ADR-0073)', async () => {
    const { data } = await next(ANNOTATOR)
    expect(Array.isArray(data?.input)).toBe(true)
    expect(typeof data?.output).toBe('string')
    expect(data?.reference).toEqual({ policy: 'Refunds within 14 days.' })
  })

  test('the FLOOR still refuses: a set on a panel below it is LOCKED, with its count', async () => {
    const { status, data } = await next(ANNOTATOR, LOCKED_SET)
    expect(status).toBe(200)
    expect(data).toEqual({ state: 'locked', trace_count: LOCKED_TRACES })
  })
})

describe('work is an ASSIGNED SET (ADR-0079)', () => {
  test('a set you are NOT assigned to is NOT_FOUND, never FORBIDDEN (ADR-0057)', async () => {
    // It is this org's set, on a panel this person can already annotate, holding traces they
    // are already being served elsewhere — and it is still not theirs to open.
    const { status, body } = await next(ANNOTATOR, UNASSIGNED_SET)
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
  })

  test('another org’s set is NOT_FOUND — the same answer, so neither can be told apart', async () => {
    const { status, body } = await next(ANNOTATOR, OTHER_SET)
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
  })

  test('the list is the sets assigned to THIS person, with size, annotated and remaining', async () => {
    const { status, body } = await call(STRANGER, 'GET', '/annotate/sets', { org: OTHER_ORG })
    expect(status).toBe(200)
    const theirs = (body as { data: { sets: Record<string, unknown>[] } }).data.sets
    expect(theirs.map((set) => set.id)).toEqual([OTHER_SET])

    const mine = await call(ANNOTATOR, 'GET', '/annotate/sets')
    const sets = (mine.body as { data: { sets: Record<string, unknown>[] } }).data.sets
    // The unassigned set is absent, and so is the other org's.
    expect(sets.map((set) => set.id).sort()).toEqual([SET, SMALL_SET, LOCKED_SET].sort())
    const locked = sets.find((set) => set.id === LOCKED_SET)
    const open = sets.find((set) => set.id === SET)
    expect(locked).toMatchObject({ open: false, trace_count: LOCKED_TRACES, remaining: 0 })
    expect(open).toMatchObject({ open: true, size: OPEN_TRACES })
    expect(open?.remaining as number).toBeGreaterThan(0)
  })

  test('an UNASSIGNED person loses the set, and their answers stay (ADR-0086)', async () => {
    const answered = (await next(SECOND, SMALL_SET)).data?.item_id ?? ''
    expect((await answer(SECOND, answered, 'acceptable', undefined, SMALL_SET)).status).toBe(201)

    await db
      .update(schema.annotationSetAnnotators)
      .set({ unassignedAt: new Date(clock.now()) })
      .where(
        and(
          eq(schema.annotationSetAnnotators.annotationSetId, SMALL_SET),
          eq(schema.annotationSetAnnotators.userId, await userId(SECOND)),
        ),
      )

    expect((await next(SECOND, SMALL_SET)).status).toBe(404)
    const listed = await call(SECOND, 'GET', '/annotate/sets')
    const ids = (listed.body as { data: { sets: { id: string }[] } }).data.sets.map((set) => set.id)
    expect(ids).not.toContain(SMALL_SET)
    // The row is still there. Unassigning is a stamp, not a delete.
    expect(await annotationsOf(answered, SECOND)).toHaveLength(1)

    // Put them back, because the tests below assume both are on it.
    await db
      .update(schema.annotationSetAnnotators)
      .set({ unassignedAt: null })
      .where(
        and(
          eq(schema.annotationSetAnnotators.annotationSetId, SMALL_SET),
          eq(schema.annotationSetAnnotators.userId, await userId(SECOND)),
        ),
      )
  })
})

describe('the queue’s rules (ADR-0079, ADR-0081)', () => {
  /**
   * Drawn through the SERVICE rather than the route: the rule is one SQL fragment, and a
   * hundred draws through HTTP would be testing the session middleware's speed. The routes
   * are exercised by every other test in this file.
   */
  const draw = async (email: string, setId = SET) => {
    const result = await nextItem(db, {
      orgId: ORG,
      setId,
      annotatorId: await userId(email),
    })
    return result?.state === 'item' ? result.item.traceId : undefined
  }

  const drawUntil = async (email: string, wanted: string, attempts: number) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if ((await draw(email)) === wanted) return true
    }
    return false
  }

  test('a trace leaves YOUR queue when YOU answer it — and nobody else’s', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, itemId, 'acceptable')).status).toBe(201)

    // The pool is ~50, so 300 draws that never return it is the rule holding rather than the
    // shuffle being kind: by chance alone it would appear with probability 1 - (1-1/50)^300.
    expect(await drawUntil(ANNOTATOR, itemId, 300)).toBe(false)
    // SUPERSEDES ADR-0066's one-person-per-trace (ADR-0081). It is still SECOND's to answer,
    // and the overlap that produces is the raw material M6's agreement metrics are computed
    // from. 600 draws rather than 300 for the positive case: over a pool of ~50 the chance of
    // a shuffle never landing on one trace in 300 tries is about 1 in 500.
    expect(await drawUntil(SECOND, itemId, 600)).toBe(true)
  })

  test('the pool is the SET: a draw never returns a trace outside it', async () => {
    const seen = new Set<string>()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const drawn = await draw(ENGINEER, SMALL_SET)
      if (drawn !== undefined) seen.add(drawn)
    }
    // ENGINEER is not assigned to SMALL_SET, so they get nothing at all from it.
    expect([...seen]).toEqual([])

    const mine = new Set<string>()
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const drawn = await draw(ANNOTATOR, SMALL_SET)
      if (drawn !== undefined) mine.add(drawn)
    }
    expect([...mine].every((traceId) => smallTraceIds.includes(traceId))).toBe(true)
  })

  test('TWO annotators each get the WHOLE set, and neither is served a trace twice', async () => {
    const drain = async (email: string) => {
      const served: string[] = []
      for (let attempt = 0; attempt < 20 && served.length < smallTraceIds.length; attempt += 1) {
        const itemId = (await next(email, SMALL_SET)).data?.item_id
        if (itemId === undefined) break
        served.push(itemId)
        expect((await answer(email, itemId, 'acceptable', undefined, SMALL_SET)).status).toBe(201)
      }
      return served
    }

    const mine = await drain(ANNOTATOR)
    const theirs = await drain(SECOND)

    // NOBODY IS SERVED A TRACE TWICE: within one drain, every id is distinct.
    expect(new Set(mine).size).toBe(mine.length)
    expect(new Set(theirs).size).toBe(theirs.length)

    // AND EACH GETS THE WHOLE SET — read from the rows rather than from what this drain
    // happened to serve, because an earlier test may already have answered some of it. That is
    // the claim either way: when the queue is empty for you, you have answered all of it.
    const answeredBy = async (email: string) => {
      const rows = await db
        .select({ traceId: schema.annotations.traceId })
        .from(schema.annotations)
        .where(
          and(
            eq(schema.annotations.annotationSetId, SMALL_SET),
            eq(schema.annotations.annotatorId, await userId(email)),
          ),
        )
      return [...new Set(rows.map((row) => row.traceId))].sort()
    }
    expect(await answeredBy(ANNOTATOR)).toEqual([...smallTraceIds].sort())
    expect(await answeredBy(SECOND)).toEqual([...smallTraceIds].sort())

    expect((await next(ANNOTATOR, SMALL_SET)).data?.state).toBe('drained')
    expect((await next(SECOND, SMALL_SET)).data?.state).toBe('drained')
  })

  /**
   * THE DERIVATION'S POINT (ADR-0086). The set is finished; assigning a third person makes it
   * unfinished again, because it genuinely is. A stored `completed_at` would still say done.
   */
  test('a DONE set becomes not-done when a third annotator is assigned', async () => {
    const before = (await setProgress(db, [SMALL_SET])).get(SMALL_SET)
    expect(before?.size).toBe(smallTraceIds.length)
    expect(before?.annotators).toHaveLength(2)
    expect(before?.done).toBe(true)

    await db.insert(schema.annotationSetAnnotators).values({
      annotationSetId: SMALL_SET,
      userId: await userId(ENGINEER),
      assignedBy: await userId(ENGINEER),
    })
    const after = (await setProgress(db, [SMALL_SET])).get(SMALL_SET)
    expect(after?.done).toBe(false)
    expect(after?.annotators.find((row) => row.answered === 0)).toBeDefined()

    // Unassigning them makes it done again: done reads `unassigned_at IS NULL`, and one
    // unassigned person must never block a set from ever completing.
    await db
      .update(schema.annotationSetAnnotators)
      .set({ unassignedAt: new Date(clock.now()) })
      .where(
        and(
          eq(schema.annotationSetAnnotators.annotationSetId, SMALL_SET),
          eq(schema.annotationSetAnnotators.userId, await userId(ENGINEER)),
        ),
      )
    expect((await setProgress(db, [SMALL_SET])).get(SMALL_SET)?.done).toBe(true)
  })

  test('a set with nobody assigned, or with no traces, is NOT done', async () => {
    // Both are vacuously true under "everyone has answered everything", and both mean a pass
    // that has not happened.
    const empty = (await setProgress(db, [UNASSIGNED_SET])).get(UNASSIGNED_SET)
    expect(empty?.annotators).toEqual([])
    expect(empty?.done).toBe(false)
  })

  test('a SKIP never returns to the skipper, and is still somebody else’s to answer', async () => {
    const itemId = (await next(SECOND)).data?.item_id ?? ''
    expect((await answer(SECOND, itemId, 'skipped')).status).toBe(201)

    // "I cannot judge this" is a fact about the pairing of person and trace, not about the
    // trace — so it leaves this person's queue and nobody else's.
    expect(await drawUntil(SECOND, itemId, 300)).toBe(false)
    expect(await drawUntil(ANNOTATOR, itemId, 600)).toBe(true)
  })

  test('`remaining` counts what is left AFTER this item, and drops as answers land', async () => {
    const before = (await next(ANNOTATOR)).data
    const itemId = before?.item_id ?? ''
    expect(
      (await answer(ANNOTATOR, itemId, 'not_acceptable', 'Refuses a refund the policy allows.'))
        .status,
    ).toBe(201)
    const after = (await next(ANNOTATOR)).data
    expect(after?.remaining).toBe((before?.remaining ?? 0) - 1)
  })

  test('`annotated` counts this person’s answers here for good, and a skip is not an annotation', async () => {
    const before = (await next(ENGINEER)).data?.annotated ?? 0

    const first = (await next(ENGINEER)).data?.item_id ?? ''
    expect((await answer(ENGINEER, first, 'acceptable')).status).toBe(201)
    expect((await next(ENGINEER)).data?.annotated).toBe(before + 1)

    // A skip is an answer we store, but it is not an annotation: pressing S must not run it up.
    const skipped = (await next(ENGINEER)).data?.item_id ?? ''
    expect((await answer(ENGINEER, skipped, 'skipped')).status).toBe(201)
    expect((await next(ENGINEER)).data?.annotated).toBe(before + 1)

    // And it is the SERVER's count, so a fresh request — a person coming back tomorrow —
    // sees it rather than zero. (The page held this in component state until 2026-09-20.)
    const listed = await call(ENGINEER, 'GET', '/annotate/sets')
    const rows = (listed.body as { data: { sets: { id: string; annotated: number }[] } }).data.sets
    expect(rows.find((row) => row.id === SET)?.annotated).toBe(before + 1)
  })

  /**
   * "Annotators only" is the assumption a future reader will bring, so the test says otherwise
   * (M5 decision 3, revised 2026-09-21). A developer is ASSIGNED a set like anybody else and
   * annotates it on this surface — what ADR-0084 forbids is arriving without having chosen to,
   * which is a console question rather than a queue one. The queue keys on `annotator_id` and
   * asks no question about role at all.
   */
  test('a DEVELOPER assigned a set is served it like anybody else (ADR-0064, ADR-0084)', async () => {
    const { status, data } = await next(ENGINEER)
    expect(status).toBe(200)
    expect(data?.state).toBe('item')
  })
})

describe('one step back (stakeholder, 2026-09-20)', () => {
  test('nothing behind you is `none`, not an error', async () => {
    const { status, data } = await stepBack(SECOND, LOCKED_SET)
    expect(status).toBe(200)
    expect(data).toEqual({ state: 'none' } as never)
  })

  test('serves the LAST thing you answered, with what you said', async () => {
    const first = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, first, 'acceptable')).status).toBe(201)
    const second = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, second, 'skipped')).status).toBe(201)

    const back = await stepBack(ANNOTATOR)
    // The skip, not the acceptable: one step, and a skip is a last answer like any other.
    expect(back.data?.item_id).toBe(second)
    expect(back.data?.previous_outcome).toBe('skipped')
    // The roles come with it, so the screen draws the same trace rather than an id.
    expect(back.data?.output).toBeDefined()
  })

  test('answering again APPENDS — the first answer is still there, and the latest is last', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, itemId, 'acceptable')).status).toBe(201)
    expect((await stepBack(ANNOTATOR)).data?.item_id).toBe(itemId)
    expect(
      (await answer(ANNOTATOR, itemId, 'not_acceptable', 'Caught it on the second read.')).status,
    ).toBe(201)

    const rows = await annotationsOf(itemId, ANNOTATOR)
    expect(rows.map((row) => row.outcome)).toEqual(['acceptable', 'not_acceptable'])
    // And stepping back now serves the SAME trace with the corrected answer on it.
    const again = await stepBack(ANNOTATOR)
    expect(again.data?.item_id).toBe(itemId)
    expect(again.data?.previous_outcome).toBe('not_acceptable')
  })

  test('it is YOUR last answer — another annotator’s does not surface here', async () => {
    const mine = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, mine, 'acceptable')).status).toBe(201)
    const theirs = (await next(SECOND)).data?.item_id ?? ''
    expect((await answer(SECOND, theirs, 'acceptable')).status).toBe(201)

    expect((await stepBack(ANNOTATOR)).data?.item_id).toBe(mine)
    expect((await stepBack(SECOND)).data?.item_id).toBe(theirs)
  })
})

describe('the row that gets written', () => {
  test('carries the annotator, the trace’s pinned version, the sampler, and its note', async () => {
    const item = (await next(ANNOTATOR)).data
    const itemId = item?.item_id ?? ''
    const note = 'Quotes a policy that does not say that.'
    const created = await answer(ANNOTATOR, itemId, 'not_acceptable', note)
    expect(created.status).toBe(201)

    const [row] = await annotationsOf(itemId, ANNOTATOR)
    expect(row).toMatchObject({
      orgId: ORG,
      panelId: OPEN_PANEL,
      // COPIED FROM THE TRACE, never from the client (ADR-0003).
      panelVersionId: OPEN_VERSION,
      annotationSetId: SET,
      annotatorId: await userId(ANNOTATOR),
      outcome: 'not_acceptable',
      note,
      // The MEMBERSHIP ROW's picker, not the constant 'random' it was while the queue itself
      // was the sampler. `SET` was filled by `random_n`; `SMALL_SET` below was filled by hand.
      sampler: 'random_n',
    })
  })

  test('`sampler` is the picker that put the trace in THIS set, not a constant', async () => {
    const itemId = (await next(ENGINEER)).data?.item_id ?? ''
    expect((await answer(ENGINEER, itemId, 'acceptable')).status).toBe(201)
    const [fromRandom] = await annotationsOf(itemId, ENGINEER)
    expect(fromRandom?.sampler).toBe('random_n')

    // The same person, a manually-picked set: a different row, a different answer to "which
    // strategy found the failures" — which is unanswerable retroactively if it is not stored.
    const manual = (await next(SECOND, SMALL_SET)).data?.item_id
    if (manual !== undefined) {
      expect((await answer(SECOND, manual, 'acceptable', undefined, SMALL_SET)).status).toBe(201)
      const rows = await annotationsOf(manual, SECOND)
      expect(rows.at(-1)?.sampler).toBe('manual')
    }
  })

  test('the audit event names the annotation and the outcome, and NEVER the note', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    const note = 'Customer said their address is 42 Elm Street.'
    const created = await answer(ANNOTATOR, itemId, 'not_acceptable', note)
    const annotationId = (created.body as { data: { id: string } }).data.id

    const [event] = await db
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, annotationId))
    expect(event?.action).toBe('annotation.created')
    expect(event?.data).toMatchObject({ outcome: 'not_acceptable', has_note: true })
    expect(JSON.stringify(event?.data)).not.toContain('Elm Street')
  })

  test('a changed mind is a NEW ROW; the first answer is still there', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, itemId, 'acceptable')).status).toBe(201)
    expect(
      (await answer(ANNOTATOR, itemId, 'not_acceptable', 'On reflection, wrong.')).status,
    ).toBe(201)
    const rows = await annotationsOf(itemId, ANNOTATOR)
    expect(rows.map((row) => row.outcome)).toEqual(['acceptable', 'not_acceptable'])
  })

  test('an item in another org is NOT_FOUND, and writes nothing', async () => {
    const [theirs] = await db
      .select({ id: schema.traces.id })
      .from(schema.traces)
      .where(eq(schema.traces.panelId, OTHER_PANEL))
      .limit(1)
    const itemId = theirs?.id ?? ''
    const { status, body } = await answer(ANNOTATOR, itemId, 'acceptable')
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
    expect(await annotationsOf(itemId, ANNOTATOR)).toEqual([])
  })

  test('answering a trace that is NOT IN THE SET is NOT_FOUND, and writes nothing', async () => {
    // A trace of the same panel, served to this person from the big set every day — and not a
    // member of the small one. The write is authorised by the membership row, not by the org.
    const outside = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect(smallTraceIds).not.toContain(outside)
    const { status, body } = await answer(ANNOTATOR, outside, 'acceptable', undefined, SMALL_SET)
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
  })

  test('answering in a set you are NOT assigned to is NOT_FOUND', async () => {
    const [inside] = await db
      .select({ traceId: schema.annotationSetTraces.traceId })
      .from(schema.annotationSetTraces)
      .where(eq(schema.annotationSetTraces.annotationSetId, UNASSIGNED_SET))
      .limit(1)
    const itemId = inside?.traceId ?? ''
    const { status } = await answer(ANNOTATOR, itemId, 'acceptable', undefined, UNASSIGNED_SET)
    expect(status).toBe(404)
  })
})

describe('the note rules (ADR-0066)', () => {
  test('“not acceptable” without a note is a 422 on the note field', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    for (const note of [undefined, '', '   ']) {
      const { status, body } = await answer(ANNOTATOR, itemId, 'not_acceptable', note)
      expect(status).toBe(422)
      expect(codeOf(body)?.issues?.[0]?.path).toBe('note')
    }
    expect(await annotationsOf(itemId, ANNOTATOR)).toEqual([])
  })

  test('a note over 280 characters is refused, and a skip may not carry one', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    const long = await answer(ANNOTATOR, itemId, 'not_acceptable', 'x'.repeat(281))
    expect(long.status).toBe(422)

    const skipped = await answer(ANNOTATOR, itemId, 'skipped', 'but here is why')
    expect(skipped.status).toBe(422)
    expect(codeOf(skipped.body)?.issues?.[0]?.path).toBe('note')
  })

  test('a skip stores no note at all', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, itemId, 'skipped')).status).toBe(201)
    const [row] = await annotationsOf(itemId, ANNOTATOR)
    expect(row?.note).toBeNull()
  })
})

describe('append-only, by grant rather than by convention', () => {
  test('the app role cannot UPDATE or DELETE an annotation (SQLSTATE 42501)', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, itemId, 'acceptable')).status).toBe(201)

    // Drizzle wraps a driver error, so the SQLSTATE is on the CAUSE, not on what it threw.
    const sqlState = (error: unknown): string | undefined => {
      const wrapped = error as { code?: string; cause?: { code?: string } }
      return wrapped?.cause?.code ?? wrapped?.code
    }

    const updated = await db
      .update(schema.annotations)
      .set({ outcome: 'not_acceptable' })
      .where(eq(schema.annotations.traceId, itemId))
      .catch((error: unknown) => error)
    expect(sqlState(updated)).toBe('42501')

    const deleted = await db
      .delete(schema.annotations)
      .where(eq(schema.annotations.traceId, itemId))
      .catch((error: unknown) => error)
    expect(sqlState(deleted)).toBe('42501')

    // And the row is still exactly as it was written.
    const [row] = await annotationsOf(itemId, ANNOTATOR)
    expect(row?.outcome).toBe('acceptable')
  })

  test('the CHECK backs the contract up: a bad note cannot be inserted directly either', async () => {
    const [anyTrace] = await db
      .select({ id: schema.traces.id })
      .from(schema.traces)
      .where(and(eq(schema.traces.panelId, OPEN_PANEL)))
      .limit(1)
    const insert = db
      .insert(schema.annotations)
      .values({
        id: newId('ann_'),
        orgId: ORG,
        traceId: anyTrace?.id ?? '',
        panelId: OPEN_PANEL,
        panelVersionId: OPEN_VERSION,
        annotationSetId: SET,
        annotatorId: await userId(ANNOTATOR),
        outcome: 'not_acceptable',
        note: null,
        sampler: 'random_n',
      })
      .catch((error: unknown) => error)
    const failure = (await insert) as { cause?: { constraint?: string } }
    expect(failure?.cause?.constraint).toBe('annotations_note_rules')
  })
})
