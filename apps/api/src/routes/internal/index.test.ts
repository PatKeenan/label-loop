import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { metrics, trace } from '@opentelemetry/api'
import { eq, sql } from 'drizzle-orm'
import { createFixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { createAuth } from '../../auth.ts'
import { loadConfig } from '../../config.ts'
import { FAKE_MODEL } from '../../llm/fake-provider.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { sha256Hex } from '../../middleware/api-key-auth.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import { insertJudge, insertJudgeVersion } from '../../repositories/panels.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * The console surface, end to end: a real better-auth sign-in against a real Postgres,
 * producing a real session cookie, read by a real guard, returning rows a real evaluation
 * wrote.
 *
 * The claim it exists to prove is the one CONVENTIONS.md makes and nothing else checks:
 * **the two auth paths never cross.** An API key must not open a console route, a session
 * must not open `/v1`, and neither must leak another org's rows. Those are four assertions
 * that only mean something against real credentials, so nothing here is faked but the
 * provider and the queue.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the console integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

/** Fresh per run, so the test is repeatable and leaves nothing behind. */
const ORG = newId('org_')
const OTHER_ORG = newId('org_')
const PANEL = newId('pnl_')
const OTHER_PANEL = newId('pnl_')
/** A second panel in the SAME org, so "scoped to the panel" has something to get wrong. */
const SIBLING_PANEL = newId('pnl_')
const PANEL_VERSION = newId('pnv_')
const OTHER_PANEL_VERSION = newId('pnv_')
const SIBLING_PANEL_VERSION = newId('pnv_')
const KEY = newId('key_')
const TRACE = newId('tr_')
const OTHER_TRACE = newId('tr_')
const SIBLING_TRACE = newId('tr_')
const LEGACY_TRACE = newId('tr_')
/** A panel whose traces sit on the edges a pagination cursor can get wrong. */
/** A judge whose verdict hangs off TRACE, so the detail read's judge join has a row. */
const JUDGE = newId('jud_')
const JUDGE_VERSION = newId('jdv_')
const ANNOTATOR_EMAIL = `annotator-${ORG}@labelloop.test`.toLowerCase()
const PAGED_PANEL = newId('pnl_')
const PAGED_PANEL_VERSION = newId('pnv_')

/** A real, active key for `PANEL` — the credential that must NOT open a console route. */
const API_KEY_PLAINTEXT = `llk_test_${'d'.repeat(64)}`

// Lowercase, because better-auth normalises addresses on sign-up and a fixture that
// searches for the mixed-case original finds nothing.
const MEMBER_EMAIL = `member-${ORG}@labelloop.test`.toLowerCase()
const OUTSIDER_EMAIL = `outsider-${ORG}@labelloop.test`.toLowerCase()
const PASSWORD = 'localdev-password'

let db: Database
let auth: ReturnType<typeof createAuth>

const noopTracer = trace.getTracer('test')
/** The same, for metrics: a real meter with a no-op implementation behind it. */
const noopMeter = metrics.getMeter('test')

const app = (authOverride?: ReturnType<typeof createAuth>) =>
  createApp({
    config,
    clock: createFixedClock(),
    errorReporter: createRecordingErrorReporter(),
    db,
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock: createFixedClock(),
      tracer: noopTracer,
      meter: noopMeter,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: noopMeter,
    auth: authOverride ?? auth,
    rateLimitStore: createMemoryRateLimitStore(),
    modelProvider: createFakeProvider(),
    catalogue: fakeCatalogue(),
  })

/** One trace per org, so "the list is scoped to my org" has something to get wrong. */
const seedFixtures = async () => {
  await db.insert(schema.orgs).values([
    { id: ORG, slug: `test-${ORG}`, name: 'Console test' },
    { id: OTHER_ORG, slug: `test-${OTHER_ORG}`, name: 'Somebody else' },
  ])
  await db.insert(schema.panels).values([
    { id: PANEL, orgId: ORG, slug: 'issue-triage', name: 'Issue triage' },
    { id: OTHER_PANEL, orgId: OTHER_ORG, slug: 'theirs', name: 'Theirs' },
    { id: SIBLING_PANEL, orgId: ORG, slug: 'reply-gate', name: 'Reply gate' },
    { id: PAGED_PANEL, orgId: ORG, slug: 'paged', name: 'Paged' },
  ])
  await db.insert(schema.panelVersions).values([
    { id: PANEL_VERSION, panelId: PANEL, version: 1, threshold: 0.5 },
    { id: OTHER_PANEL_VERSION, panelId: OTHER_PANEL, version: 1, threshold: 0.5 },
    { id: SIBLING_PANEL_VERSION, panelId: SIBLING_PANEL, version: 1, threshold: 0.5 },
    { id: PAGED_PANEL_VERSION, panelId: PAGED_PANEL, version: 1, threshold: 0.5 },
  ])
  await db.insert(schema.apiKeys).values({
    id: KEY,
    orgId: ORG,
    panelId: PANEL,
    name: 'Console test',
    hash: sha256Hex(API_KEY_PLAINTEXT),
    last4: API_KEY_PLAINTEXT.slice(-4),
  })
  await db.insert(schema.traces).values([
    {
      id: TRACE,
      orgId: ORG,
      panelId: PANEL,
      panelVersionId: PANEL_VERSION,
      apiKeyId: KEY,
      requestId: 'a'.repeat(32),
      input: [{ role: 'user', content: 'Why can I not log in?' }],
      output: 'Login button does nothing on Safari 17.',
      reference: { browser: { name: 'Safari', version: 17 } },
      metadata: { ticket: 'T-1' },
      passed: true,
      score: 1,
      complete: true,
      threshold: 0.5,
    },
    {
      id: OTHER_TRACE,
      orgId: OTHER_ORG,
      panelId: OTHER_PANEL,
      panelVersionId: OTHER_PANEL_VERSION,
      requestId: 'b'.repeat(32),
      output: 'Not yours.',
      passed: false,
      score: 0,
      complete: true,
      threshold: 0.5,
    },
    {
      id: SIBLING_TRACE,
      orgId: ORG,
      panelId: SIBLING_PANEL,
      panelVersionId: SIBLING_PANEL_VERSION,
      requestId: 'c'.repeat(32),
      output: 'Yours, but another panel’s.',
      passed: null,
      score: null,
      complete: true,
      threshold: 0.5,
    },
    {
      // A trace written BEFORE the four roles existed, as the migrations left it (ADR-0074):
      // `output` and `reference` backfilled by 0013 from the `artifact` and `context` that
      // 0014 then dropped, and `input` never recorded — which is what makes it legacy.
      id: LEGACY_TRACE,
      orgId: ORG,
      panelId: PANEL,
      panelVersionId: PANEL_VERSION,
      requestId: 'd'.repeat(32),
      output: 'P2 — the export button is misaligned.',
      reference: { your_agent_decision: 'p2' },
      passed: null,
      score: null,
      complete: true,
      threshold: 0.5,
    },
  ])
}

/**
 * Five traces on the edges a cursor gets wrong, newest first as the list must return them:
 * one alone, TWO WITH THE SAME TIMESTAMP (only `id` can order them), and two 100µs apart
 * inside one millisecond (a cursor built from a JS `Date` cannot tell them apart).
 */
const PAGED_TRACES = [
  { at: '2026-01-01 00:00:05+00' },
  { at: '2026-01-01 00:00:04+00' },
  { at: '2026-01-01 00:00:04+00' },
  { at: '2026-01-01 00:00:03.000200+00' },
  { at: '2026-01-01 00:00:03.000100+00' },
].map((row) => ({ ...row, id: newId('tr_') }))

/** The order the API must return them in: time descending, then id descending on a tie. */
const PAGED_ORDER = [...PAGED_TRACES]
  .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
  .map((row) => row.id)

const seedVerdict = async () => {
  await insertJudge(db, {
    id: JUDGE,
    panelId: PANEL,
    slug: 'is-missing-repro',
    name: 'Missing repro',
    createdBy: null,
  })
  await insertJudgeVersion(db, {
    id: JUDGE_VERSION,
    judgeId: JUDGE,
    version: 1,
    polarity: 'fails',
    weight: 1,
    required: false,
    question: 'Does this issue lack reproduction steps?',
    model: FAKE_MODEL,
    modelPin: DEFAULT_FAKE_PIN,
    modelPinValidation: {
      validated_at: new Date(0).toISOString(),
      available_endpoints: 0,
      served_by: FAKE_MODEL,
    },
    createdBy: null,
  })
  await db.insert(schema.traceVerdicts).values({
    traceId: TRACE,
    judgeVersionId: JUDGE_VERSION,
    status: 'evaluated',
    verdict: false,
    passed: true,
    rationale: 'The report names the browser and the exact click.',
    reasons: [],
    confidence: 0.92,
    weight: 1,
    servedBy: FAKE_MODEL,
    latencyMs: 12,
    attempts: 1,
    costPriced: false,
  })
}

const seedPagedTraces = async () => {
  for (const [index, row] of PAGED_TRACES.entries()) {
    await db.insert(schema.traces).values({
      id: row.id,
      orgId: ORG,
      panelId: PAGED_PANEL,
      panelVersionId: PAGED_PANEL_VERSION,
      requestId: index.toString(16).padStart(32, '0'),
      output: 'paged',
      passed: null,
      score: null,
      complete: true,
      threshold: 0.5,
      // A literal, not a `Date`: the microseconds ARE the test.
      createdAt: sql`${row.at}::timestamptz`,
    })
  }
}

const dropFixtures = async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await db.delete(schema.traces).where(eq(schema.traces.orgId, org))
    await db.delete(schema.orgs).where(eq(schema.orgs.id, org))
  }
  for (const email of [MEMBER_EMAIL, OUTSIDER_EMAIL, ANNOTATOR_EMAIL]) {
    await db.delete(schema.user).where(eq(schema.user.email, email))
  }
}

/**
 * Both fixtures go through the MOUNTED handler rather than through better-auth's API
 * object, because part of what is under test is that it IS mounted, at this path, and
 * answering. `signIn` returns the `Cookie` header a browser would send back.
 */
const signUp = async (email: string) => {
  const response = await app().request('http://localhost/internal/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Test person' }),
  })
  expect(response.status).toBe(200)
}

const signIn = async (email: string): Promise<string> => {
  const response = await app().request('http://localhost/internal/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  expect(response.status).toBe(200)

  const setCookie = response.headers.getSetCookie()
  expect(setCookie.length).toBeGreaterThan(0)
  return setCookie.map((cookie) => cookie.split(';')[0]).join('; ')
}

/** Membership is ours, not better-auth's (ADR-0014), so it is a separate insert. */
const grantMembership = async (email: string, role: 'admin' | 'annotator' = 'admin') => {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  const userId = rows[0]?.id
  if (userId === undefined) throw new Error(`no user for ${email}`)
  await db.insert(schema.orgMembers).values({ orgId: ORG, userId, role }).onConflictDoNothing()
}

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  auth = createAuth(db, config)
  await dropFixtures()
  await seedFixtures()
  await seedVerdict()
  await seedPagedTraces()

  // Two accounts, identical but for one row in `org_members` — which is the whole
  // difference between seeing the console and being told you are not a member of anything.
  await signUp(MEMBER_EMAIL)
  await grantMembership(MEMBER_EMAIL)
  await signUp(OUTSIDER_EMAIL)
  await signUp(ANNOTATOR_EMAIL)
  await grantMembership(ANNOTATOR_EMAIL, 'annotator')
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

describe('a signed-in member', () => {
  test('sees who they are, and the org the session resolved to', async () => {
    const cookie = await signIn(MEMBER_EMAIL)

    const response = await app().request('http://localhost/internal/me', { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { email: string; active_org_id: string; role: string }
      request_id: string
    }
    expect(body.data.email).toBe(MEMBER_EMAIL)
    expect(body.data.active_org_id).toBe(ORG)
    expect(body.data.role).toBe('admin')
    // The envelope holds here exactly as it does on `/v1` (ADR-0010).
    expect(body.request_id).toMatch(/^[0-9a-f]{32}$/)
  })

  const traceIds = async (cookie: string, panelId: string) => {
    const response = await app().request(`http://localhost/internal/traces?panel_id=${panelId}`, {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { traces: { id: string }[] } }
    return body.data.traces.map((row) => row.id)
  }

  test('sees ONE panel’s traces — not its sibling’s, and not another org’s', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const ids = await traceIds(cookie, PANEL)

    expect(ids).toContain(TRACE)
    // Same org, different panel: the row phase 7's org-wide list showed under the wrong heading.
    expect(ids).not.toContain(SIBLING_TRACE)
    // The row that exists, belongs to somebody else, and is one forgotten `where` away.
    expect(ids).not.toContain(OTHER_TRACE)
  })

  test('another org’s panel id answers an empty list, not that org’s rows', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    // The panel filter narrows WITHIN the session's org and never replaces it. Empty, not
    // NOT_FOUND, is the same answer a real panel with no traffic gets — it confirms nothing.
    expect(await traceIds(cookie, OTHER_PANEL)).toEqual([])
  })

  test('no panel_id is a 422 — there is no org-wide trace list', async () => {
    const cookie = await signIn(MEMBER_EMAIL)

    const response = await app().request('http://localhost/internal/traces', {
      headers: { cookie },
    })
    expect(response.status).toBe(422)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.data?.error.code).toBe('VALIDATION_ERROR')
    expect(parsed.data?.error.issues?.map((issue) => issue.path)).toContain('panel_id')
  })

  test('pages through every trace exactly once — across a timestamp tie and a sub-ms gap', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const seen: string[] = []
    let cursor: string | null = null
    let pages = 0
    do {
      const response = await app().request(
        `http://localhost/internal/traces?panel_id=${PAGED_PANEL}&limit=2${
          cursor === null ? '' : `&before=${cursor}`
        }`,
        { headers: { cookie } },
      )
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        data: { traces: { id: string }[]; next_cursor: string | null }
      }
      seen.push(...body.data.traces.map((trace) => trace.id))
      cursor = body.data.next_cursor
      pages += 1
    } while (cursor !== null && pages < 10)

    // Exact order, no repeats, nothing missed — and no empty trailing page: 5 rows at 2 a page
    // is 3 pages, and the third says there is no fourth.
    expect(seen).toEqual(PAGED_ORDER)
    expect(pages).toBe(3)
  })

  test('a cursor the API did not issue is a 422 on `before`, not a 500', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const forged = Buffer.from(JSON.stringify(["now'); drop table traces; --", 'tr_x'])).toString(
      'base64url',
    )
    for (const before of ['not-base64-json', forged]) {
      const response = await app().request(
        `http://localhost/internal/traces?panel_id=${PAGED_PANEL}&before=${before}`,
        { headers: { cookie } },
      )
      expect(response.status).toBe(422)
      const parsed = errorEnvelopeSchema.safeParse(await response.json())
      expect(parsed.data?.error.issues?.map((issue) => issue.path)).toEqual(['before'])
    }
  })

  test('a limit outside the allowed range is a 422 in the standard envelope', async () => {
    const cookie = await signIn(MEMBER_EMAIL)

    const response = await app().request(
      `http://localhost/internal/traces?panel_id=${PANEL}&limit=0`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(422)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('VALIDATION_ERROR')
  })
})

describe('the two auth paths never cross (CONVENTIONS.md “Keys & auth”)', () => {
  test('no credential at all is a 401 on the console', async () => {
    const response = await app().request('http://localhost/internal/traces')
    expect(response.status).toBe(401)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.data?.error.code).toBe('UNAUTHORIZED')
  })

  test('a VALID api key opens no console route', async () => {
    // Not a malformed or revoked key — the real, active one that works on `/v1` two tests
    // below. The console never looks at `Authorization`, so it is simply nobody.
    const response = await app().request('http://localhost/internal/traces', {
      headers: { authorization: `Bearer ${API_KEY_PLAINTEXT}` },
    })
    expect(response.status).toBe(401)
  })

  test('a VALID session cookie opens nothing on /v1', async () => {
    const cookie = await signIn(MEMBER_EMAIL)

    const response = await app().request(`http://localhost/v1/panels/${PANEL}/evaluate`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'the task', output: 'anything' }),
    })
    expect(response.status).toBe(401)
  })

  test('and the api key still works where it belongs, so the test above proves something', async () => {
    const response = await app().request(`http://localhost/v1/panels/${PANEL}/evaluate`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${API_KEY_PLAINTEXT}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: 'the task',
        output: 'Login button does nothing on Safari 17.',
      }),
    })
    // 404: the panel has no live version in this fixture, which is a decision the route
    // reached AFTER authenticating. The point is that it got past the key check at all.
    expect(response.status).not.toBe(401)
  })
})

describe('authenticated but a member of nothing', () => {
  test('is a 403, not a 401 — there is no secret left to keep', async () => {
    const cookie = await signIn(OUTSIDER_EMAIL)

    const response = await app().request('http://localhost/internal/traces', {
      headers: { cookie },
    })
    expect(response.status).toBe(403)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.data?.error.code).toBe('FORBIDDEN')
  })
})

describe('better-auth’s own endpoints are not behind the guard', () => {
  test('signing in does not require being signed in', async () => {
    // The regression this catches is a one-line reordering in `createInternalRoutes`: put
    // `sessionAuth()` above the auth handler and every login 401s, which is a bug that
    // looks like a broken password.
    const response = await app().request('http://localhost/internal/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: MEMBER_EMAIL, password: 'wrong-password-entirely' }),
    })
    // Rejected by better-auth on the merits, which means it was REACHED.
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('UNAUTHORIZED')
  })
})

describe('the login screen asks which doors exist (Deviation 11)', () => {
  const methods = async (authOverride?: ReturnType<typeof createAuth>) => {
    // No cookie: this is asked before anyone is signed in.
    const response = await app(authOverride).request('http://localhost/internal/sign-in-methods')
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: { email_password: boolean; github: boolean } }).data
  }

  test('a clone with no GitHub credentials offers the password form only', async () => {
    expect(await methods()).toEqual({ email_password: true, github: false })
  })

  test('production with GitHub configured offers GitHub only (ADR-0049)', async () => {
    // Read off the auth object the HANDLER was built with, so this is the same fact that
    // decides whether a sign-in succeeds — not a second reading of the config.
    const production = createAuth(db, {
      ...config,
      NODE_ENV: 'production',
      GITHUB_CLIENT_ID: 'test-client-id',
      GITHUB_CLIENT_SECRET: 'test-client-secret',
    })
    expect(await methods(production)).toEqual({ email_password: false, github: true })
  })
})

/** Just the fields these tests read — the real shape is the RPC type the console consumes. */
type Detail = {
  data: {
    input: unknown
    output: unknown
    reference: unknown
    metadata: unknown
    key_name: string | null
    panel_version: number
    passed: boolean | null
    judges: unknown[]
  }
  error: { code: string }
}

describe('one trace, whole — the console’s trace drawer (Deviation 75)', () => {
  const detail = async (cookie: string, id: string) => {
    const response = await app().request(`http://localhost/internal/traces/${id}`, {
      headers: { cookie },
    })
    return { status: response.status, body: (await response.json()) as Detail }
  }

  test('returns what went in and what each judge said', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const { status, body } = await detail(cookie, TRACE)
    expect(status).toBe(200)
    // The four roles, in the shapes they were sent in (ADR-0073) — and not the retired pair.
    expect(body.data).toMatchObject({
      input: [{ role: 'user', content: 'Why can I not log in?' }],
      output: 'Login button does nothing on Safari 17.',
      reference: { browser: { name: 'Safari', version: 17 } },
      metadata: { ticket: 'T-1' },
    })
    expect(body.data).not.toHaveProperty('artifact')
    expect(body.data).not.toHaveProperty('context')
    expect(body.data.key_name).toBe('Console test')
    expect(body.data.panel_version).toBe(1)
    expect(body.data.judges).toEqual([
      expect.objectContaining({
        slug: 'is-missing-repro',
        question: 'Does this issue lack reproduction steps?',
        polarity: 'fails',
        status: 'evaluated',
        verdict: false,
        passed: true,
        rationale: 'The report names the browser and the exact click.',
        confidence: expect.closeTo(0.92, 5),
      }),
    ])
  })

  test('a LEGACY trace reads from its backfill, with no input — never an invented one', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const { status, body } = await detail(cookie, LEGACY_TRACE)
    expect(status).toBe(200)
    expect(body.data).toMatchObject({
      input: null,
      output: 'P2 — the export button is misaligned.',
      reference: { your_agent_decision: 'p2' },
      metadata: null,
    })
  })

  test('a COLLECTING trace has no judges — none ran — and says so with an empty list', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const { status, body } = await detail(cookie, SIBLING_TRACE)
    expect(status).toBe(200)
    expect(body.data.passed).toBeNull()
    expect(body.data.judges).toEqual([])
  })

  test('another org’s trace is NOT_FOUND, never FORBIDDEN (ADR-0057)', async () => {
    const cookie = await signIn(MEMBER_EMAIL)
    const { status, body } = await detail(cookie, OTHER_TRACE)
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  test('an annotator is refused — the drawer carries rationale and confidence', async () => {
    const cookie = await signIn(ANNOTATOR_EMAIL)
    const { status, body } = await detail(cookie, TRACE)
    expect(status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
  })
})
