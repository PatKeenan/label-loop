import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema, newId } from '@labelloop/contracts'
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
import { changeRole } from '../../services/members.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * Members and invitations (ADR-0065, ADR-0070), against a real better-auth session and a real
 * Postgres — the claim's whole security is a join on `user.email_verified`, and the last-admin
 * guard is a row lock, so neither means anything against a fake.
 *
 * The case that matters most is the unverified one: anyone can sign up with email and password
 * as an address they do not own, so an invitation claimed on an unverified match is an
 * invitation claimed by whoever typed the address first.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the members integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

const ORG = newId('org_')
/** Somebody else's org, with a member and an invitation of its own — the rows a leak exposes. */
const OTHER_ORG = newId('org_')
const tag = ORG.slice(-8).toLowerCase()

const ADMIN = `admin-${tag}@labelloop.test`
const ENGINEER = `engineer-${tag}@labelloop.test`
const VERIFIED = `verified-${tag}@labelloop.test`
const UNVERIFIED = `unverified-${tag}@labelloop.test`
const LATE = `late-${tag}@labelloop.test`
const REVOKED = `revoked-${tag}@labelloop.test`
const STRANGER = `stranger-${tag}@labelloop.test`
const EMAILS = [ADMIN, ENGINEER, VERIFIED, UNVERIFIED, LATE, REVOKED, STRANGER]
const PASSWORD = 'localdev-password'

const DAY_MS = 24 * 60 * 60 * 1000

let db: Database
let auth: ReturnType<typeof createAuth>
/** Shared by every request, so a test can move time and have both invite and claim see it. */
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
  // Orgs first: invitations cascade with them, and they RESTRICT the users they name.
  await db.delete(schema.orgs).where(inArray(schema.orgs.id, [ORG, OTHER_ORG]))
  await db.delete(schema.user).where(inArray(schema.user.email, EMAILS))
}

const post = (path: string, body: unknown) =>
  app().request(`http://localhost/internal/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const signIn = async (email: string): Promise<string> => {
  const response = await post('sign-in/email', { email, password: PASSWORD })
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

const userId = async (email: string): Promise<string> => {
  const [row] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  if (row === undefined) throw new Error(`no user for ${email}`)
  return row.id
}

/** A console call as `email`, in `org`. */
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

type Me = { data: { memberships: { org_id: string; role: string }[] } }

/** `/me` with no org header — the console's bootstrap read, and so the claim. */
const me = async (email: string) => {
  const response = await app().request('http://localhost/internal/me', {
    headers: { cookie: await signIn(email) },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as Me).data.memberships
}

const roleIn = async (email: string, org = ORG) => {
  const [row] = await db
    .select({ role: schema.orgMembers.role })
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, org), eq(schema.orgMembers.userId, await userId(email))))
  return row?.role
}

const invitationOf = async (email: string) =>
  db.select().from(schema.orgInvitations).where(eq(schema.orgInvitations.email, email))

const auditActions = async (subjectId: string) =>
  (
    await db
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.subjectId, subjectId))
      .orderBy(schema.auditEvents.createdAt)
  ).map((row) => row.action)

const codeOf = (body: Record<string, unknown>) => errorEnvelopeSchema.safeParse(body).data?.error

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  clock = createFixedClock(Date.parse('2026-09-18T12:00:00Z'))
  auth = createAuth(db, config)
  await dropFixtures()

  await db.insert(schema.orgs).values([
    { id: ORG, slug: `members-${tag}`, name: 'Members org' },
    { id: OTHER_ORG, slug: `other-${tag}`, name: 'Somebody else' },
  ])
  for (const email of EMAILS) {
    expect((await post('sign-up/email', { email, password: PASSWORD, name: 'Test' })).status).toBe(
      200,
    )
  }
  // Verified as GitHub would report it. Every address but UNVERIFIED's.
  await db
    .update(schema.user)
    .set({ emailVerified: true })
    .where(
      inArray(
        schema.user.email,
        EMAILS.filter((email) => email !== UNVERIFIED),
      ),
    )

  await db.insert(schema.orgMembers).values([
    { orgId: ORG, userId: await userId(ADMIN), role: 'admin' },
    { orgId: ORG, userId: await userId(ENGINEER), role: 'engineer' },
    { orgId: OTHER_ORG, userId: await userId(STRANGER), role: 'admin' },
  ])
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

describe('the claim, on /me (ADR-0065)', () => {
  test('a VERIFIED email joins with the invited role, and the audit row says so', async () => {
    const invited = await call(ADMIN, 'POST', '/invitations', {
      body: { email: `  ${VERIFIED.toUpperCase()} `, role: 'annotator' },
    })
    expect(invited.status).toBe(201)
    const [invitation] = await invitationOf(VERIFIED)
    // Stored lowercased and trimmed, which is what lets the claim match it.
    expect(invitation?.email).toBe(VERIFIED)

    expect((await me(VERIFIED)).map((m) => [m.org_id, m.role])).toEqual([[ORG, 'annotator']])
    expect(await roleIn(VERIFIED)).toBe('annotator')

    const [claimed] = await invitationOf(VERIFIED)
    expect(claimed?.acceptedBy).toBe(await userId(VERIFIED))
    expect(await auditActions(claimed?.id ?? '')).toEqual([
      'invitation.created',
      'invitation.accepted',
    ])
  })

  test('a second claim is a no-op', async () => {
    const [before] = await invitationOf(VERIFIED)
    expect((await me(VERIFIED)).length).toBe(1)
    expect(await auditActions(before?.id ?? '')).toEqual([
      'invitation.created',
      'invitation.accepted',
    ])
  })

  test('an UNVERIFIED email claims nothing, however exactly it matches', async () => {
    expect(
      (await call(ADMIN, 'POST', '/invitations', { body: { email: UNVERIFIED, role: 'engineer' } }))
        .status,
    ).toBe(201)

    expect(await me(UNVERIFIED)).toEqual([])
    expect(await roleIn(UNVERIFIED)).toBeUndefined()
    const [invitation] = await invitationOf(UNVERIFIED)
    expect(invitation?.acceptedAt).toBeNull()
  })

  test('an EXPIRED invitation claims nothing', async () => {
    expect(
      (await call(ADMIN, 'POST', '/invitations', { body: { email: LATE, role: 'engineer' } }))
        .status,
    ).toBe(201)

    clock.advance(15 * DAY_MS)
    try {
      expect(await me(LATE)).toEqual([])
      expect(await roleIn(LATE)).toBeUndefined()

      // And an expired one does not block inviting the same person again.
      const again = await call(ADMIN, 'POST', '/invitations', {
        body: { email: LATE, role: 'annotator' },
      })
      expect(again.status).toBe(201)
      const rows = await invitationOf(LATE)
      expect(rows.filter((row) => row.revokedAt === null)).toHaveLength(1)
    } finally {
      clock.advance(-15 * DAY_MS)
    }
  })

  test('a REVOKED invitation claims nothing', async () => {
    const invited = await call(ADMIN, 'POST', '/invitations', {
      body: { email: REVOKED, role: 'admin' },
    })
    const id = (invited.body.data as { id: string }).id
    expect((await call(ADMIN, 'DELETE', `/invitations/${id}`)).status).toBe(200)

    expect(await me(REVOKED)).toEqual([])
    expect(await auditActions(id)).toEqual(['invitation.created', 'invitation.revoked'])
  })
})

describe('inviting', () => {
  test('an existing member cannot be invited, and says so on the field', async () => {
    const { status, body } = await call(ADMIN, 'POST', '/invitations', {
      body: { email: ENGINEER, role: 'admin' },
    })
    expect(status).toBe(422)
    expect(codeOf(body)?.code).toBe('VALIDATION_ERROR')
  })

  test('a second open invitation to one email is refused', async () => {
    const { status } = await call(ADMIN, 'POST', '/invitations', {
      body: { email: UNVERIFIED, role: 'annotator' },
    })
    expect(status).toBe(422)
  })

  test('guest_expert is not a grantable role until M8 (ADR-0072)', async () => {
    const { status } = await call(ADMIN, 'POST', '/invitations', {
      body: { email: `guest-${tag}@labelloop.test`, role: 'guest_expert' },
    })
    expect(status).toBe(422)
  })

  test('an engineer may read members but not invite', async () => {
    expect((await call(ENGINEER, 'GET', '/members')).status).toBe(200)
    expect(
      (
        await call(ENGINEER, 'POST', '/invitations', {
          body: { email: `x-${tag}@labelloop.test`, role: 'annotator' },
        })
      ).status,
    ).toBe(403)
  })

  test('the list carries members and OPEN invitations only', async () => {
    const { body } = await call(ADMIN, 'GET', '/members')
    const data = body.data as { members: { email: string }[]; invitations: { email: string }[] }
    expect(data.members.map((m) => m.email).sort()).toEqual([ADMIN, ENGINEER, VERIFIED].sort())
    // Accepted (VERIFIED) and revoked (REVOKED) are gone; the unverified one is still waiting.
    expect(data.invitations.map((i) => i.email).sort()).toEqual([LATE, UNVERIFIED].sort())
  })
})

describe('the last admin (decision 14)', () => {
  test('the only admin cannot be demoted — a field error, not a 403', async () => {
    const { status, body } = await call(ADMIN, 'PATCH', `/members/${await userId(ADMIN)}`, {
      body: { role: 'engineer' },
    })
    expect(status).toBe(422)
    expect(codeOf(body)?.code).toBe('VALIDATION_ERROR')
    expect(await roleIn(ADMIN)).toBe('admin')
  })

  test('the only admin cannot be removed', async () => {
    expect((await call(ADMIN, 'DELETE', `/members/${await userId(ADMIN)}`)).status).toBe(422)
    expect(await roleIn(ADMIN)).toBe('admin')
  })

  test('with a second admin, the first may step down — and each change is audited', async () => {
    const engineerId = await userId(ENGINEER)
    expect(
      (await call(ADMIN, 'PATCH', `/members/${engineerId}`, { body: { role: 'admin' } })).status,
    ).toBe(200)
    expect(
      (
        await call(ADMIN, 'PATCH', `/members/${await userId(ADMIN)}`, {
          body: { role: 'engineer' },
        })
      ).status,
    ).toBe(200)
    expect(await roleIn(ADMIN)).toBe('engineer')

    // Put it back through the new admin, which is also the proof the capability moved with it.
    expect(
      (
        await call(ENGINEER, 'PATCH', `/members/${await userId(ADMIN)}`, {
          body: { role: 'admin' },
        })
      ).status,
    ).toBe(200)
    expect(
      (await call(ADMIN, 'PATCH', `/members/${engineerId}`, { body: { role: 'engineer' } })).status,
    ).toBe(200)

    expect(await auditActions(engineerId)).toEqual(['member.role_changed', 'member.role_changed'])
  })

  test('two admins demoting each other at once cannot both succeed', async () => {
    // Through the SERVICE, not the routes: over HTTP the second request's session is often
    // resolved after the first demotion lands, and it is refused as a non-admin (403) before it
    // reaches the lock. Here both writes are already past any guard, so the row lock on the
    // org's admins is the only thing that can stop the second.
    const engineerId = await userId(ENGINEER)
    const adminId = await userId(ADMIN)
    await call(ADMIN, 'PATCH', `/members/${engineerId}`, { body: { role: 'admin' } })

    const demote = (actorId: string, target: string) =>
      changeRole({
        db,
        clock,
        orgId: ORG,
        actorId,
        requestId: 'race',
        userId: target,
        role: 'engineer',
      })
    const results = await Promise.all([demote(adminId, engineerId), demote(engineerId, adminId)])

    expect(results.map((r) => (r.ok ? 'ok' : r.kind)).sort()).toEqual(['last_admin', 'ok'])
    const admins = await db
      .select({ userId: schema.orgMembers.userId })
      .from(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, ORG), eq(schema.orgMembers.role, 'admin')))
    expect(admins).toHaveLength(1)

    // Restore: ADMIN is the admin, ENGINEER the engineer.
    if (admins[0]?.userId !== adminId) {
      await changeRole({
        db,
        clock,
        orgId: ORG,
        actorId: engineerId,
        requestId: 'restore',
        userId: adminId,
        role: 'admin',
      })
    }
    await changeRole({
      db,
      clock,
      orgId: ORG,
      actorId: adminId,
      requestId: 'restore',
      userId: engineerId,
      role: 'engineer',
    })
  })
})

describe('removing', () => {
  test('a removed member loses the org, and the removal is audited', async () => {
    const verifiedId = await userId(VERIFIED)
    expect((await call(ADMIN, 'DELETE', `/members/${verifiedId}`)).status).toBe(200)
    expect(await roleIn(VERIFIED)).toBeUndefined()
    expect(await me(VERIFIED)).toEqual([])
    expect((await auditActions(verifiedId)).at(-1)).toBe('member.removed')
  })
})

describe("another org's rows are NOT_FOUND (ADR-0057)", () => {
  test("changing another org's member", async () => {
    const { status, body } = await call(ADMIN, 'PATCH', `/members/${await userId(STRANGER)}`, {
      body: { role: 'annotator' },
    })
    expect(status).toBe(404)
    expect(codeOf(body)?.code).toBe('NOT_FOUND')
    expect(await roleIn(STRANGER, OTHER_ORG)).toBe('admin')
  })

  test("removing another org's member", async () => {
    expect((await call(ADMIN, 'DELETE', `/members/${await userId(STRANGER)}`)).status).toBe(404)
    expect(await roleIn(STRANGER, OTHER_ORG)).toBe('admin')
  })

  test("revoking another org's invitation", async () => {
    const theirs = await call(STRANGER, 'POST', '/invitations', {
      body: { email: `theirs-${tag}@labelloop.test`, role: 'engineer' },
      org: OTHER_ORG,
    })
    expect(theirs.status).toBe(201)
    const id = (theirs.body.data as { id: string }).id

    expect((await call(ADMIN, 'DELETE', `/invitations/${id}`)).status).toBe(404)
    const [row] = await db
      .select()
      .from(schema.orgInvitations)
      .where(eq(schema.orgInvitations.id, id))
    expect(row?.revokedAt).toBeNull()
  })
})

describe('a body that is not JSON', () => {
  test('is the same 422 as any invalid body, never a 500', async () => {
    const response = await app().request(
      `http://localhost/internal/members/${await userId(ENGINEER)}`,
      {
        method: 'PATCH',
        headers: {
          cookie: await signIn(ADMIN),
          [ACTIVE_ORG_HEADER]: ORG,
          'content-type': 'application/json',
        },
        body: '{not json',
      },
    )
    expect(response.status).toBe(422)
    expect(codeOf((await response.json()) as Record<string, unknown>)?.code).toBe(
      'VALIDATION_ERROR',
    )
  })
})
