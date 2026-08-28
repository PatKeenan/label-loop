import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { trace } from '@opentelemetry/api'
import { eq } from 'drizzle-orm'
import { createFixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { createAuth } from '../../auth.ts'
import { loadConfig } from '../../config.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { sha256Hex } from '../../middleware/api-key-auth.ts'
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
const PANEL_VERSION = newId('pnv_')
const OTHER_PANEL_VERSION = newId('pnv_')
const KEY = newId('key_')
const TRACE = newId('tr_')
const OTHER_TRACE = newId('tr_')

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

const app = () =>
  createApp({
    config,
    clock: createFixedClock(),
    errorReporter: createRecordingErrorReporter(),
    db,
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock: createFixedClock(),
      tracer: noopTracer,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    auth,
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
  ])
  await db.insert(schema.panelVersions).values([
    { id: PANEL_VERSION, panelId: PANEL, version: 1, threshold: 0.5 },
    { id: OTHER_PANEL_VERSION, panelId: OTHER_PANEL, version: 1, threshold: 0.5 },
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
      artifact: 'Login button does nothing on Safari 17.',
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
      artifact: 'Not yours.',
      passed: false,
      score: 0,
      complete: true,
      threshold: 0.5,
    },
  ])
}

const dropFixtures = async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await db.delete(schema.traces).where(eq(schema.traces.orgId, org))
    await db.delete(schema.orgs).where(eq(schema.orgs.id, org))
  }
  for (const email of [MEMBER_EMAIL, OUTSIDER_EMAIL]) {
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
const grantMembership = async (email: string) => {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  const userId = rows[0]?.id
  if (userId === undefined) throw new Error(`no user for ${email}`)
  await db
    .insert(schema.orgMembers)
    .values({ orgId: ORG, userId, role: 'admin' })
    .onConflictDoNothing()
}

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  auth = createAuth(db, config)
  await dropFixtures()
  await seedFixtures()

  // Two accounts, identical but for one row in `org_members` — which is the whole
  // difference between seeing the console and being told you are not a member of anything.
  await signUp(MEMBER_EMAIL)
  await grantMembership(MEMBER_EMAIL)
  await signUp(OUTSIDER_EMAIL)
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
      data: { email: string; org_id: string; role: string }
      request_id: string
    }
    expect(body.data.email).toBe(MEMBER_EMAIL)
    expect(body.data.org_id).toBe(ORG)
    expect(body.data.role).toBe('admin')
    // The envelope holds here exactly as it does on `/v1` (ADR-0010).
    expect(body.request_id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('sees their org’s traces, and ONLY their org’s', async () => {
    const cookie = await signIn(MEMBER_EMAIL)

    const response = await app().request('http://localhost/internal/traces', {
      headers: { cookie },
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { traces: { id: string }[] } }
    const ids = body.data.traces.map((row) => row.id)
    expect(ids).toContain(TRACE)
    // The row that exists, belongs to somebody else, and is one forgotten `where` away.
    expect(ids).not.toContain(OTHER_TRACE)
  })

  test('a limit outside the allowed range is a 422 in the standard envelope', async () => {
    const cookie = await signIn(MEMBER_EMAIL)

    const response = await app().request('http://localhost/internal/traces?limit=0', {
      headers: { cookie },
    })
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
      body: JSON.stringify({ artifact: 'anything' }),
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
      body: JSON.stringify({ artifact: 'Login button does nothing on Safari 17.' }),
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
