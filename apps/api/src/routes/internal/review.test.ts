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
import { nextItem } from '../../services/annotation-queue.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * THE REVIEW QUEUE, against a real Postgres and a real better-auth session (ADR-0066).
 *
 * The three claims worth a database: what the payload does NOT contain (ADR-0067, ADR-0077),
 * who the queue serves a trace to (one person, a skip frees it, never back to the skipper),
 * and that the table cannot be edited afterwards — which is a grant, so only Postgres can
 * answer it.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the review integration test needs a running Postgres.\n' +
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

const ANNOTATOR = `annotator-${tag}@labelloop.test`
const SECOND = `second-${tag}@labelloop.test`
const ENGINEER = `engineer-${tag}@labelloop.test`
const STRANGER = `stranger-${tag}@labelloop.test`
const EMAILS = [ANNOTATOR, SECOND, ENGINEER, STRANGER]
const PASSWORD = 'localdev-password'

/** One over the floor, so "the gate opens at 50" is tested at the boundary, not near it. */
const OPEN_TRACES = ANNOTATION_FLOOR + 1
const LOCKED_TRACES = ANNOTATION_FLOOR - 1

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
  trace_count?: number
}

const next = async (email: string, slug = `open-${tag}`, org = ORG) => {
  const { status, body } = await call(email, 'GET', `/review/panels/${slug}/next`, { org })
  return { status, data: (body as { data?: Item }).data, body }
}

const answer = (email: string, itemId: string, outcome: string, note?: string) =>
  call(email, 'POST', '/review/annotations', {
    body: { item_id: itemId, outcome, ...(note === undefined ? {} : { note }) },
  })

const codeOf = (body: Record<string, unknown>) => errorEnvelopeSchema.safeParse(body).data?.error

const annotationsOf = (traceId: string) =>
  db.select().from(schema.annotations).where(eq(schema.annotations.traceId, traceId))

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
    { id: ORG, slug: `review-${tag}`, name: 'Review org' },
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
  await db
    .insert(schema.traces)
    .values([
      ...traceRows(OPEN_PANEL, OPEN_VERSION, OPEN_TRACES, 'a'),
      ...traceRows(LOCKED_PANEL, LOCKED_VERSION, LOCKED_TRACES, 'b'),
      ...traceRows(OTHER_PANEL, OTHER_VERSION, OPEN_TRACES, 'c'),
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

  test('a panel below the floor is LOCKED, with its count so progress can be drawn', async () => {
    const { status, data } = await next(ANNOTATOR, `locked-${tag}`)
    expect(status).toBe(200)
    expect(data).toEqual({ state: 'locked', trace_count: LOCKED_TRACES })
  })

  test('another org’s panel is NOT_FOUND, never FORBIDDEN (ADR-0057)', async () => {
    const { status, body } = await next(ANNOTATOR, `theirs-${tag}`)
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
  })

  test('the panel list shows the gate, and a locked panel has nothing remaining', async () => {
    const { status, body } = await call(ANNOTATOR, 'GET', '/review/panels')
    expect(status).toBe(200)
    const panels = (body as { data: { panels: Record<string, unknown>[] } }).data.panels
    expect(panels.map((panel) => panel.slug).sort()).toEqual([`locked-${tag}`, `open-${tag}`])
    const locked = panels.find((panel) => panel.slug === `locked-${tag}`)
    const open = panels.find((panel) => panel.slug === `open-${tag}`)
    expect(locked).toMatchObject({ open: false, trace_count: LOCKED_TRACES, remaining: 0 })
    expect(open).toMatchObject({ open: true, trace_count: OPEN_TRACES })
    expect(open?.remaining as number).toBeGreaterThan(0)
  })
})

describe('the queue’s rules (ADR-0066, plan decision 7)', () => {
  /**
   * Drawn through the SERVICE rather than the route: the rule is one SQL fragment, and a
   * hundred draws through HTTP would be testing the session middleware's speed. The routes
   * are exercised by every other test in this file.
   */
  const draw = async (email: string) => {
    const result = await nextItem(db, {
      orgId: ORG,
      panelSlug: `open-${tag}`,
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

  test('an answered trace leaves the queue for EVERYONE, including the other annotator', async () => {
    const itemId = (await next(ANNOTATOR)).data?.item_id ?? ''
    expect((await answer(ANNOTATOR, itemId, 'acceptable')).status).toBe(201)

    // The pool is ~50, so 300 draws that never return it is the rule holding rather than the
    // shuffle being kind: by chance alone it would appear with probability 1 - (1-1/50)^300.
    expect(await drawUntil(ANNOTATOR, itemId, 300)).toBe(false)
    expect(await drawUntil(SECOND, itemId, 300)).toBe(false)
  })

  test('a SKIP frees the trace for someone else and never returns to the skipper', async () => {
    const itemId = (await next(SECOND)).data?.item_id ?? ''
    expect((await answer(SECOND, itemId, 'skipped')).status).toBe(201)

    expect(await drawUntil(SECOND, itemId, 300)).toBe(false)
    // "Not me" is not "not this": it is still somebody else's to answer.
    expect(await drawUntil(ANNOTATOR, itemId, 300)).toBe(true)
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

  test('an engineer may annotate — a role says what you may DO (ADR-0064)', async () => {
    const { status, data } = await next(ENGINEER)
    expect(status).toBe(200)
    expect(data?.state).toBe('item')
  })
})

describe('the row that gets written', () => {
  test('carries the annotator, the trace’s pinned version, the sampler, and its note', async () => {
    const item = (await next(ANNOTATOR)).data
    const itemId = item?.item_id ?? ''
    const note = 'Quotes a policy that does not say that.'
    const created = await answer(ANNOTATOR, itemId, 'not_acceptable', note)
    expect(created.status).toBe(201)

    const [row] = await annotationsOf(itemId)
    expect(row).toMatchObject({
      orgId: ORG,
      panelId: OPEN_PANEL,
      // COPIED FROM THE TRACE, never from the client (ADR-0003).
      panelVersionId: OPEN_VERSION,
      annotatorId: await userId(ANNOTATOR),
      outcome: 'not_acceptable',
      note,
      sampler: 'random',
    })
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
    const rows = await annotationsOf(itemId)
    expect(rows.map((row) => row.outcome).sort()).toEqual(['acceptable', 'not_acceptable'])
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
    expect(await annotationsOf(itemId)).toEqual([])
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
    expect(await annotationsOf(itemId)).toEqual([])
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
    const [row] = await annotationsOf(itemId)
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
    const [row] = await annotationsOf(itemId)
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
        annotatorId: await userId(ANNOTATOR),
        outcome: 'not_acceptable',
        note: null,
        sampler: 'random',
      })
      .catch((error: unknown) => error)
    const failure = (await insert) as { cause?: { constraint?: string } }
    expect(failure?.cause?.constraint).toBe('annotations_note_rules')
  })
})
