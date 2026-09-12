import { describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema } from '@labelloop/contracts'
import { metrics, trace } from '@opentelemetry/api'
import { Hono } from 'hono'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../adapters/noop-error-reporter.ts'
import { createApp } from '../app.ts'
import type { AppEnv } from '../app-env.ts'
import { type Config, loadConfig } from '../config.ts'
import { createFakeProvider, createModelGateway } from '../llm/index.ts'
import { createMemoryRateLimitStore } from '../rate-limit/memory-store.ts'
import type { OrgRole } from '../repositories/org-members.ts'
import { fakeAuth } from '../testing/fake-auth.ts'
import { fakeDatabase } from '../testing/fake-database.ts'
import { fakeQueue } from '../testing/fake-queue.ts'
import { requireRole } from './require-role.ts'

/**
 * The role guard, through the REAL composition root and the REAL central error handler, so
 * the 403 envelope is the one `app.ts` actually serializes rather than a copy of it.
 *
 * No database and no better-auth here, deliberately. Resolving WHICH role applies is
 * `sessionAuth`'s job and is tested against real Postgres in `session.test.ts`; this file
 * owns the two things the guard itself decides — whether a role passes, and what a refused
 * caller is told. A probe route is mounted onto the built app (the pattern
 * `rate-limit.test.ts` uses) because publishing a throwaway route to test middleware would
 * be worse than the duplication it saves.
 *
 * M4 registers no guarded route until phase 3, which is exactly why this test exists now:
 * the guard would otherwise ship with nothing exercising it until the keys endpoint lands.
 */

const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

/** The real app, with a probe route behind the guard and a stand-in for the session. */
const hostWith = (role: OrgRole, allowed: readonly OrgRole[]) => {
  const app = createApp({
    config,
    clock: createFixedClock(),
    errorReporter: createRecordingErrorReporter(),
    db: fakeDatabase(),
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock: createFixedClock(),
      tracer: noopTracer,
      meter: noopMeter,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: noopMeter,
    auth: fakeAuth(),
    rateLimitStore: createMemoryRateLimitStore(),
  })

  const probe = new Hono<AppEnv>()
  probe.use('/probe', async (c, next) => {
    c.set('session', {
      userId: 'user_probe',
      email: 'probe@labelloop.test',
      orgId: 'org_probe',
      role,
      memberships: [
        { orgId: 'org_probe', userId: 'user_probe', role, orgName: 'Probe', orgSlug: 'probe' },
      ],
    })
    await next()
  })
  probe.use('/probe', requireRole(...allowed))
  probe.get('/probe', (c) => c.json({ ok: true }, 200))

  app.route('/probe-host', probe)
  return app
}

const call = (role: OrgRole, allowed: readonly OrgRole[]) =>
  hostWith(role, allowed).request('/probe-host/probe')

const ENGINEER_ROUTE = ['admin', 'engineer'] as const

describe('who gets through', () => {
  test.each([['admin'], ['engineer']] as const)('%s reaches an engineer route', async (role) => {
    expect((await call(role, ENGINEER_ROUTE)).status).toBe(200)
  })

  test.each([['annotator'], ['guest_expert']] as const)(
    '%s is refused at an engineer route',
    async (role) => {
      expect((await call(role, ENGINEER_ROUTE)).status).toBe(403)
    },
  )

  test('an admin-only route refuses an engineer', async () => {
    // The case that separates this from a signed-in check: the caller is a legitimate
    // member of the org, with a real role, and still may not do this.
    expect((await call('engineer', ['admin'])).status).toBe(403)
    expect((await call('admin', ['admin'])).status).toBe(200)
  })
})

describe('what a refused caller is told', () => {
  test('the taxonomy code and the standard envelope', async () => {
    const response = await call('annotator', ENGINEER_ROUTE)

    expect(response.status).toBe(403)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('FORBIDDEN')
    expect(parsed.data?.request_id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('the message does not enumerate what the caller lacks', async () => {
    const response = await call('annotator', ENGINEER_ROUTE)
    const message = errorEnvelopeSchema.safeParse(await response.json()).data?.error.message ?? ''

    // Naming the permitted roles tells a caller exactly what to go and acquire, and
    // confirms which roles a route is worth attacking with. The console already knows the
    // caller's role from `/internal/me` and can say something useful without this doing it.
    for (const role of ['admin', 'engineer', 'annotator', 'guest_expert']) {
      expect(message).not.toContain(role)
    }
  })

  test('every refusal is the SAME message, whatever the route required', async () => {
    const atEngineerRoute = await call('annotator', ENGINEER_ROUTE)
    const atAdminRoute = await call('annotator', ['admin'])

    const messageOf = async (response: Response) =>
      errorEnvelopeSchema.safeParse(await response.json()).data?.error.message

    expect(await messageOf(atAdminRoute)).toBe((await messageOf(atEngineerRoute)) ?? '')
  })
})
