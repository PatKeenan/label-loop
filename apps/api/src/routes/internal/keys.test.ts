import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { metrics, trace } from '@opentelemetry/api'
import { and, eq } from 'drizzle-orm'
import { createFixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { createAuth } from '../../auth.ts'
import { loadConfig } from '../../config.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * Issuing, listing and revoking keys — against a real Postgres, because everything this
 * phase claims is a claim about rows: that the plaintext is not one of them, that revocation
 * leaves the row behind, that another org's key is invisible, and that `audit_events` gained
 * its first application writer (ADR-0051).
 *
 * The assertion this file exists for is the one that cannot be retrofitted: **the plaintext
 * appears exactly once, and never again.** A key that can be re-read from a list endpoint is
 * not a credential, and the failure is silent — everything still works, and the security
 * property is simply gone.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the keys integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

const ORG = newId('org_')
const OTHER_ORG = newId('org_')
const PANEL = newId('pnl_')
/** A real panel belonging to somebody else — what a mistyped or malicious `panel_id` hits. */
const OTHER_PANEL = newId('pnl_')

const ADMIN_EMAIL = `keys-admin-${ORG}@labelloop.test`.toLowerCase()
const ANNOTATOR_EMAIL = `keys-annotator-${ORG}@labelloop.test`.toLowerCase()
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
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

const grantMembership = async (email: string, orgId: string, role: 'admin' | 'annotator') => {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  const userId = rows[0]?.id
  if (userId === undefined) throw new Error(`no user for ${email}`)
  await db.insert(schema.orgMembers).values({ orgId, userId, role }).onConflictDoNothing()
}

const post = (cookie: string, path: string, body?: unknown) =>
  app().request(`http://localhost${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const get = (cookie: string, path: string) =>
  app().request(`http://localhost${path}`, { headers: { cookie } })

type IssuedBody = { data: { id: string; last4: string; key: string; shown_once: boolean } }
type ListBody = { data: { keys: { id: string; status: string; last4: string }[] } }

const issue = async (cookie: string, name = 'Test client') => {
  const response = await post(cookie, '/internal/keys', { panel_id: PANEL, name })
  expect(response.status).toBe(201)
  return (await response.json()) as IssuedBody
}

const auditRowsFor = (subjectId: string) =>
  db
    .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.subjectId, subjectId))

/**
 * **The audit rows are deliberately NOT cleaned up, because they cannot be.**
 *
 * The first draft of this file deleted them and Postgres refused with SQLSTATE 42501 —
 * `permission denied for table audit_events`. That is the append-only grant working on the
 * test's own connection: the app role holds INSERT and SELECT and nothing else, so there is
 * no privileged path for "it was only a test" (CONVENTIONS.md "Data rules"). Every id here is
 * fresh per run and every assertion is scoped to one, so accumulation changes no outcome.
 *
 * The org rows still go. `audit_events.org_id` is `ON DELETE SET NULL` rather than cascade —
 * a tenant can be removed without erasing the record that they existed — and the referential
 * action runs as the table owner rather than as the caller, which is why dropping the org
 * succeeds where deleting the event does not.
 */
const dropFixtures = async () => {
  for (const org of [ORG, OTHER_ORG]) {
    await db.delete(schema.orgs).where(eq(schema.orgs.id, org))
  }
  for (const email of [ADMIN_EMAIL, ANNOTATOR_EMAIL]) {
    await db.delete(schema.user).where(eq(schema.user.email, email))
  }
}

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  auth = createAuth(db, config)
  await dropFixtures()

  await db.insert(schema.orgs).values([
    { id: ORG, slug: `keys-${ORG}`, name: 'Keys test' },
    { id: OTHER_ORG, slug: `keys-${OTHER_ORG}`, name: 'Somebody else' },
  ])
  await db.insert(schema.panels).values([
    { id: PANEL, orgId: ORG, slug: 'issue-triage', name: 'Issue triage' },
    { id: OTHER_PANEL, orgId: OTHER_ORG, slug: 'theirs', name: 'Theirs' },
  ])

  await signUp(ADMIN_EMAIL)
  await grantMembership(ADMIN_EMAIL, ORG, 'admin')
  await signUp(ANNOTATOR_EMAIL)
  await grantMembership(ANNOTATOR_EMAIL, ORG, 'annotator')
})

/** Keys accumulate across tests, so the list assertions get a clean table each time. */
beforeEach(async () => {
  await db.delete(schema.apiKeys).where(eq(schema.apiKeys.orgId, ORG))
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

describe('the plaintext is shown exactly once', () => {
  test('creation returns a usable key, flagged as one-time', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie)

    expect(issued.data.key).toMatch(/^llk_test_[0-9a-f]{64}$/)
    expect(issued.data.last4).toBe(issued.data.key.slice(-4))
    expect(issued.data.shown_once).toBe(true)
  })

  test('and NO later response contains it', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const plaintext = (await issue(cookie)).data.key

    // The whole list, as a string: a future field carrying the key fails here rather than
    // being added quietly.
    const listed = await (await get(cookie, '/internal/keys')).text()
    expect(listed).not.toContain(plaintext)
    // Nor its secret half, in case something ever renders a prefix-stripped form.
    expect(listed).not.toContain(plaintext.slice(9))
  })

  test('and the list does not hand out the stored HASH either', async () => {
    // Not the same severity as leaking the plaintext — the secret is 32 random bytes, so a
    // SHA-256 of it is not reversible — but the hash is the lookup value on the hot path,
    // and a list endpoint is not the place to publish it. This assertion exists because a
    // mutation proved the exclusion was a comment with nothing enforcing it.
    const cookie = await signIn(ADMIN_EMAIL)
    await issue(cookie)

    const stored = await db
      .select({ hash: schema.apiKeys.hash })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, ORG))
    const hash = stored[0]?.hash
    expect(hash).toBeDefined()

    const listed = await (await get(cookie, '/internal/keys')).text()
    expect(listed).not.toContain(hash)
  })

  test('what is STORED is the hash, never the plaintext', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const plaintext = (await issue(cookie)).data.key

    const rows = await db
      .select({ hash: schema.apiKeys.hash, last4: schema.apiKeys.last4 })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, ORG))
    expect(rows[0]?.hash).not.toBe(plaintext)
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(rows[0]?.last4).toBe(plaintext.slice(-4))
  })

  test('two keys are different — the secret is random, not derived', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const first = (await issue(cookie, 'one')).data.key
    const second = (await issue(cookie, 'two')).data.key
    expect(first).not.toBe(second)
  })
})

describe('the key actually works on /v1, and stops working when revoked', () => {
  test('issued → accepted; revoked → UNAUTHORIZED', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie)

    const evaluate = () =>
      app().request(`http://localhost/v1/panels/${PANEL}/evaluate`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${issued.data.key}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ artifact: 'anything' }),
      })

    // 404, not 401: the panel has no live version in this fixture, which is a decision
    // reached AFTER authenticating. The point is that it got past the key check.
    expect((await evaluate()).status).not.toBe(401)

    expect((await post(cookie, `/internal/keys/${issued.data.id}/revoke`)).status).toBe(200)
    expect((await evaluate()).status).toBe(401)
  })

  test('revocation is a status flip — the row survives', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie)
    await post(cookie, `/internal/keys/${issued.data.id}/revoke`)

    const rows = await db
      .select({ status: schema.apiKeys.status, revokedAt: schema.apiKeys.revokedAt })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, issued.data.id))
    // Deleting it would take every `traces.api_key_id` pointing at it with it.
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('revoked')
    expect(rows[0]?.revokedAt).not.toBeNull()

    // Still listed, because hiding it would make the console disagree with the audit log.
    const list = (await (await get(cookie, '/internal/keys')).json()) as ListBody
    expect(list.data.keys.find((key) => key.id === issued.data.id)?.status).toBe('revoked')
  })

  test('revoking twice is NOT_FOUND the second time, and writes one event', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie)

    expect((await post(cookie, `/internal/keys/${issued.data.id}/revoke`)).status).toBe(200)
    expect((await post(cookie, `/internal/keys/${issued.data.id}/revoke`)).status).toBe(404)

    // An `api_key.revoked` row for a revocation that did not happen would be a permanent
    // record of a non-event, in the one table that cannot correct itself.
    const revocations = (await auditRowsFor(issued.data.id)).filter(
      (row) => row.action === 'api_key.revoked',
    )
    expect(revocations).toHaveLength(1)
  })
})

describe('tenancy', () => {
  test('a key cannot be scoped to another org’s panel, and says NOT_FOUND', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await post(cookie, '/internal/keys', {
      panel_id: OTHER_PANEL,
      name: 'Nice try',
    })

    // FORBIDDEN would confirm that panel exists (ADR-0057's posture, applied to panels).
    expect(response.status).toBe(404)
    expect(errorEnvelopeSchema.safeParse(await response.json()).data?.error.code).toBe('NOT_FOUND')

    const rows = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.panelId, OTHER_PANEL))
    expect(rows).toHaveLength(0)
  })

  test('another org’s key is neither listed nor revocable', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const theirKey = newId('key_')
    await db.insert(schema.apiKeys).values({
      id: theirKey,
      orgId: OTHER_ORG,
      panelId: OTHER_PANEL,
      name: 'Theirs',
      hash: 'f'.repeat(64),
      last4: 'ffff',
    })

    const list = (await (await get(cookie, '/internal/keys')).json()) as ListBody
    expect(list.data.keys.map((key) => key.id)).not.toContain(theirKey)

    expect((await post(cookie, `/internal/keys/${theirKey}/revoke`)).status).toBe(404)

    const rows = await db
      .select({ status: schema.apiKeys.status })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, theirKey))
    expect(rows[0]?.status).toBe('active')
    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, theirKey))
  })
})

describe('the role guard (ADR-0014, phase 1)', () => {
  test('an annotator cannot issue, list or revoke', async () => {
    const cookie = await signIn(ANNOTATOR_EMAIL)

    for (const response of [
      await post(cookie, '/internal/keys', { panel_id: PANEL, name: 'Nope' }),
      await get(cookie, '/internal/keys'),
      await post(cookie, `/internal/keys/${newId('key_')}/revoke`),
    ]) {
      expect(response.status).toBe(403)
    }
  })

  test('and a VALID api key opens none of them either', async () => {
    // The two auth paths still never cross, on the surface that mints the keys.
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie)

    const response = await app().request('http://localhost/internal/keys', {
      headers: { authorization: `Bearer ${issued.data.key}` },
    })
    expect(response.status).toBe(401)
  })
})

describe('audit_events gains its first application writer (ADR-0051)', () => {
  test('issuance and revocation are both recorded, with actor and request_id', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie, 'Audited')
    await post(cookie, `/internal/keys/${issued.data.id}/revoke`)

    const rows = await db
      .select({
        action: schema.auditEvents.action,
        actorType: schema.auditEvents.actorType,
        actorId: schema.auditEvents.actorId,
        requestId: schema.auditEvents.requestId,
        data: schema.auditEvents.data,
      })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, issued.data.id))

    expect(rows.map((row) => row.action).sort()).toEqual(['api_key.issued', 'api_key.revoked'])
    for (const row of rows) {
      expect(row.actorType).toBe('user')
      expect(row.actorId).not.toBeNull()
      // Bound to the execution, so an event joins to its spans (ADR-0010).
      expect(row.requestId).toMatch(/^[0-9a-f]{32}$/)
    }
  })

  test('the event records last4 and NEVER the key', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const issued = await issue(cookie)

    const rows = await auditRowsFor(issued.data.id)
    const serialised = JSON.stringify(rows)
    // This table has no DELETE and M8 adds export: a secret written here leaves and cannot
    // be taken back out.
    expect(serialised).not.toContain(issued.data.key)
    expect(serialised).toContain(issued.data.last4)
  })

  test('a failed issue writes NO key row and NO event — one transaction', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const before = await db
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.orgId, ORG), eq(schema.auditEvents.action, 'api_key.issued')),
      )

    // Refused at the panel check, before the transaction opens.
    await post(cookie, '/internal/keys', { panel_id: OTHER_PANEL, name: 'Nope' })

    const after = await db
      .select({ id: schema.auditEvents.id })
      .from(schema.auditEvents)
      .where(
        and(eq(schema.auditEvents.orgId, ORG), eq(schema.auditEvents.action, 'api_key.issued')),
      )
    expect(after).toHaveLength(before.length)
  })
})

describe('validation', () => {
  test.each([
    ['no panel_id', { name: 'x' }],
    ['no name', { panel_id: PANEL }],
    ['blank name', { panel_id: PANEL, name: '   ' }],
    ['name too long', { panel_id: PANEL, name: 'x'.repeat(81) }],
  ])('%s is a 422 in the standard envelope', async (_label, body) => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await post(cookie, '/internal/keys', body)

    expect(response.status).toBe(422)
    expect(errorEnvelopeSchema.safeParse(await response.json()).data?.error.code).toBe(
      'VALIDATION_ERROR',
    )
  })
})
