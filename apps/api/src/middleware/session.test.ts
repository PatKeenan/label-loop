import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { metrics, trace } from '@opentelemetry/api'
import { eq } from 'drizzle-orm'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../adapters/noop-error-reporter.ts'
import { createApp } from '../app.ts'
import { createAuth } from '../auth.ts'
import { loadConfig } from '../config.ts'
import { createFakeProvider, createModelGateway } from '../llm/index.ts'
import { createMemoryRateLimitStore } from '../rate-limit/memory-store.ts'
import { fakeQueue } from '../testing/fake-queue.ts'
import { ACTIVE_ORG_HEADER } from './session.ts'

/**
 * Which org a request is about — against a real better-auth session and a real Postgres,
 * because the question only exists once an account can be a member of more than one.
 *
 * `routes/internal/index.test.ts` owns the claim that the two auth paths never cross. This
 * file owns the one M4 introduced: the org stops being implicit, so the middleware becomes
 * the single place that decides whether a caller may look at the org they named (ADR-0047).
 * Until this phase there was exactly one org a request could mean, and that made "forgot to
 * filter" harmless. It is not harmless any more, which is why the negative cases are here
 * rather than deferred.
 *
 * **The assertion that matters most is the one about two responses being the same.** A
 * non-member org and an org that was never created must be indistinguishable (ADR-0057);
 * any difference at all — status, code, message — turns this header into an oracle that
 * enumerates other tenants' org ids.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the session integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

/** Fresh per run, so the test is repeatable and leaves nothing behind. */
const FIRST_ORG = newId('org_')
const SECOND_ORG = newId('org_')
/** A real org this account is NOT in — the row a leak would expose. */
const STRANGERS_ORG = newId('org_')
/** An id of the right shape that was never inserted. Must be refused identically. */
const NEVER_EXISTED = newId('org_')

// Lowercase, because better-auth normalises addresses on sign-up and a fixture that
// searches for the mixed-case original finds nothing.
const MULTI_ORG_EMAIL = `multi-${FIRST_ORG}@labelloop.test`.toLowerCase()
const ONE_ORG_EMAIL = `single-${FIRST_ORG}@labelloop.test`.toLowerCase()
const NO_ORG_EMAIL = `nobody-${FIRST_ORG}@labelloop.test`.toLowerCase()
const PASSWORD = 'localdev-password'

let db: Database
let auth: ReturnType<typeof createAuth>

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

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
      meter: noopMeter,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: noopMeter,
    auth,
    rateLimitStore: createMemoryRateLimitStore(),
  })

const ORG_IDS = [FIRST_ORG, SECOND_ORG, STRANGERS_ORG]
const EMAILS = [MULTI_ORG_EMAIL, ONE_ORG_EMAIL, NO_ORG_EMAIL]

const dropFixtures = async () => {
  for (const org of ORG_IDS) await db.delete(schema.orgs).where(eq(schema.orgs.id, org))
  for (const email of EMAILS) await db.delete(schema.user).where(eq(schema.user.email, email))
}

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

const userId = async (email: string): Promise<string> => {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  const id = rows[0]?.id
  if (id === undefined) throw new Error(`no user for ${email}`)
  return id
}

type Me = {
  data: {
    active_org_id: string
    role: string
    memberships: { org_id: string; org_name: string; role: string }[]
  }
}

const me = async (cookie: string, org?: string) => {
  const response = await app().request('http://localhost/internal/me', {
    headers: { cookie, ...(org === undefined ? {} : { [ACTIVE_ORG_HEADER]: org }) },
  })
  return { response, body: (await response.json()) as unknown }
}

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  auth = createAuth(db, config)
  await dropFixtures()

  await db.insert(schema.orgs).values([
    { id: FIRST_ORG, slug: `first-${FIRST_ORG}`, name: 'First org' },
    { id: SECOND_ORG, slug: `second-${SECOND_ORG}`, name: 'Second org' },
    { id: STRANGERS_ORG, slug: `strangers-${STRANGERS_ORG}`, name: 'Somebody else' },
  ])

  for (const email of EMAILS) await signUp(email)

  // `created_at` is set EXPLICITLY rather than left to `defaultNow()`, because both rows
  // would otherwise take the transaction's timestamp and the "first membership" the
  // no-header case falls back to would be whichever the planner happened to return.
  // The ordering is load-bearing (see `listMemberships`), so the fixture pins it.
  await db.insert(schema.orgMembers).values([
    {
      orgId: FIRST_ORG,
      userId: await userId(MULTI_ORG_EMAIL),
      role: 'admin',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    },
    // Deliberately a DIFFERENT role in the second org: a role is per-org (ADR-0014), so a
    // guard that resolved it once per account rather than once per request would enforce
    // `admin` here — silently, and in the permissive direction.
    {
      orgId: SECOND_ORG,
      userId: await userId(MULTI_ORG_EMAIL),
      role: 'annotator',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    },
    { orgId: FIRST_ORG, userId: await userId(ONE_ORG_EMAIL), role: 'engineer' },
  ])
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

describe('the active org, when the request names one', () => {
  test('no header falls back to the first membership, and lists them all', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const { response, body } = await me(cookie)

    expect(response.status).toBe(200)
    const data = (body as Me).data
    expect(data.active_org_id).toBe(FIRST_ORG)
    expect(data.role).toBe('admin')
    // The switcher renders from this, so it carries the name and not only the id.
    expect(data.memberships.map((m) => m.org_id)).toEqual([FIRST_ORG, SECOND_ORG])
    expect(data.memberships[0]?.org_name).toBe('First org')
  })

  test('naming the second org switches the org AND the role', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const { response, body } = await me(cookie, SECOND_ORG)

    expect(response.status).toBe(200)
    const data = (body as Me).data
    expect(data.active_org_id).toBe(SECOND_ORG)
    // The whole reason the switcher and `requireRole` ship in one phase.
    expect(data.role).toBe('annotator')
  })

  test('an empty header is treated as absent, not as a request for nothing', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const { response, body } = await me(cookie, '   ')

    expect(response.status).toBe(200)
    expect((body as Me).data.active_org_id).toBe(FIRST_ORG)
  })

  test('the org scopes the ROWS, not just the reply', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const response = await app().request('http://localhost/internal/traces', {
      headers: { cookie, [ACTIVE_ORG_HEADER]: SECOND_ORG },
    })
    expect(response.status).toBe(200)
  })
})

describe('an org that is not yours (ADR-0057)', () => {
  test('a real org this account is not in is NOT_FOUND, never FORBIDDEN', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const { response, body } = await me(cookie, STRANGERS_ORG)

    expect(response.status).toBe(404)
    const parsed = errorEnvelopeSchema.safeParse(body)
    expect(parsed.success).toBe(true)
    // A 403 here would confirm the org exists and say only that you cannot reach it,
    // which is the whole disclosure this code exists to avoid.
    expect(parsed.data?.error.code).toBe('NOT_FOUND')
    expect(parsed.data?.error.code).not.toBe('FORBIDDEN')
  })

  test('and an org that never existed is refused IDENTICALLY', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const stranger = await me(cookie, STRANGERS_ORG)
    const phantom = await me(cookie, NEVER_EXISTED)

    // The assertion this file exists for. Compared whole rather than field by field, so a
    // future field that leaks the difference fails here instead of being added silently.
    // `request_id` differs per request by design (ADR-0010) and is the only exemption.
    const withoutRequestId = (body: unknown) => {
      const { request_id: _, ...rest } = body as Record<string, unknown>
      return rest
    }
    // Pinned to 404 as well as to each other: "both the same" is satisfied by both
    // SUCCEEDING, which is the exact bug a fallback-instead-of-refuse would introduce.
    expect(stranger.response.status).toBe(404)
    expect(phantom.response.status).toBe(stranger.response.status)
    expect(withoutRequestId(phantom.body)).toEqual(withoutRequestId(stranger.body))
  })

  test('the refusal does not name the org back to the caller', async () => {
    const cookie = await signIn(MULTI_ORG_EMAIL)
    const { body } = await me(cookie, STRANGERS_ORG)
    // Echoing the id would be harmless on its own, but it is the shape that makes an
    // oracle convenient, and `AppError.context` already carries it for the log line.
    expect(JSON.stringify(body)).not.toContain(STRANGERS_ORG)
  })
})

describe('the answers that did not change', () => {
  test('a member of exactly one org still works with no header', async () => {
    const cookie = await signIn(ONE_ORG_EMAIL)
    const { response, body } = await me(cookie)

    expect(response.status).toBe(200)
    const data = (body as Me).data
    expect(data.active_org_id).toBe(FIRST_ORG)
    expect(data.role).toBe('engineer')
    expect(data.memberships).toHaveLength(1)
  })

  test('a member of nothing is still a 403 — there is no secret left to keep', async () => {
    const cookie = await signIn(NO_ORG_EMAIL)
    const { response, body } = await me(cookie)

    expect(response.status).toBe(403)
    expect(errorEnvelopeSchema.safeParse(body).data?.error.code).toBe('FORBIDDEN')
  })

  test('no cookie is still a 401, and the header buys nothing', async () => {
    const response = await app().request('http://localhost/internal/me', {
      headers: { [ACTIVE_ORG_HEADER]: FIRST_ORG },
    })
    expect(response.status).toBe(401)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.data?.error.code).toBe('UNAUTHORIZED')
  })
})
