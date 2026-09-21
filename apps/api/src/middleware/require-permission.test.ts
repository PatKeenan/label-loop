import { describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema, type OrgRole, ROLES } from '@labelloop/contracts'
import { metrics, trace } from '@opentelemetry/api'
import { Hono } from 'hono'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../adapters/noop-error-reporter.ts'
import { createApp } from '../app.ts'
import type { AppEnv } from '../app-env.ts'
import { type Config, loadConfig } from '../config.ts'
import { createFakeProvider, createModelGateway } from '../llm/index.ts'
import { createMemoryRateLimitStore } from '../rate-limit/memory-store.ts'
import { createAnnotateRoutes } from '../routes/internal/annotate.ts'
import { createAnnotationSetRoutes } from '../routes/internal/annotation-sets.ts'
import { createJudgeRoutes } from '../routes/internal/judges.ts'
import { createKeyRoutes } from '../routes/internal/keys.ts'
import { createMemberRoutes } from '../routes/internal/members.ts'
import { createModelRoutes } from '../routes/internal/models.ts'
import { createPanelRoutes } from '../routes/internal/panels.ts'
import { createTraceRoutes } from '../routes/internal/traces.ts'
import { fakeAuth } from '../testing/fake-auth.ts'
import { fakeCatalogue } from '../testing/fake-catalogue.ts'
import { fakeDatabase } from '../testing/fake-database.ts'
import { fakeQueue } from '../testing/fake-queue.ts'

/**
 * The capability guard, through the REAL composition root and the REAL central error handler,
 * so the 403 envelope is the one `app.ts` actually serializes rather than a copy of it.
 *
 * Two halves. **The matrix**: every role against every guarded console route, with the
 * expected outcome written out per route rather than derived from `can()` — deriving it would
 * test the map against itself. `capabilities.test.ts` owns what each role is granted; this
 * owns what each route ASKS for. **The refusal**: what a refused caller is told.
 *
 * No database and no better-auth, deliberately. Resolving WHICH role applies is `sessionAuth`'s
 * job, tested against real Postgres in `session.test.ts`. So an admitted request goes on to a
 * handler that meets a fake database and may answer 422 or 500; "admitted" is therefore
 * asserted as *not refused by the guard*, which is the one thing the guard decides.
 */

const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

const guardedRoutes = () =>
  new Hono<AppEnv>()
    .route('/', createKeyRoutes())
    .route('/', createPanelRoutes())
    .route('/', createModelRoutes())
    .route('/', createJudgeRoutes())
    .route('/', createTraceRoutes())
    .route('/', createMemberRoutes())
    .route('/', createAnnotateRoutes())
    .route('/', createAnnotationSetRoutes())

/** The real app, with the console routes mounted behind a stand-in for the session. */
const hostWith = (role: OrgRole) => {
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
    modelProvider: createFakeProvider(),
    catalogue: fakeCatalogue(),
  })

  const probe = new Hono<AppEnv>()
  probe.use('*', async (c, next) => {
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
  probe.route('/', guardedRoutes())
  app.route('/probe', probe)
  return app
}

const STAFF: readonly OrgRole[] = ['admin', 'engineer']
const ADMIN: readonly OrgRole[] = ['admin']
/**
 * The annotator surface is the one place an annotator is admitted — and staff are admitted too,
 * because a role says what you may DO and the surface is a preference (ADR-0064). A
 * `guest_expert` holds nothing until M8 (ADR-0072), so they are refused here like everywhere.
 */
const ANNOTATORS: readonly OrgRole[] = ['admin', 'engineer', 'annotator']

type RouteCase = {
  /** As Hono registers it — what the coverage check below compares against. */
  route: string
  /** A concrete request to that route. */
  url: string
  admitted: readonly OrgRole[]
}

/**
 * EVERY guarded console route, and who gets through. A route added to one of these files
 * without a row here fails the coverage test below, so this table cannot fall behind.
 */
const MATRIX: readonly RouteCase[] = [
  { route: 'POST /keys', url: '/keys', admitted: STAFF },
  { route: 'GET /keys', url: '/keys', admitted: STAFF },
  { route: 'POST /keys/:key_id/revoke', url: '/keys/key_x/revoke', admitted: STAFF },
  { route: 'POST /panels', url: '/panels', admitted: STAFF },
  { route: 'GET /panels/:slug', url: '/panels/some-panel', admitted: STAFF },
  { route: 'GET /panels', url: '/panels', admitted: STAFF },
  { route: 'GET /models', url: '/models', admitted: STAFF },
  { route: 'GET /models/:model_id{.+}/endpoints', url: '/models/a/b/endpoints', admitted: STAFF },
  { route: 'POST /judges/validate-pin', url: '/judges/validate-pin', admitted: STAFF },
  // Deviation 32 closed: the LIST is staff-only now, not only the detail (ADR-0068).
  { route: 'GET /traces', url: '/traces?panel_id=pnl_x', admitted: STAFF },
  { route: 'GET /traces/:id', url: '/traces/tr_x', admitted: STAFF },
  // Reading who is in the org is staff; changing it is the admin's alone (ADR-0070).
  { route: 'GET /members', url: '/members', admitted: STAFF },
  { route: 'POST /invitations', url: '/invitations', admitted: ADMIN },
  { route: 'DELETE /invitations/:id', url: '/invitations/inv_x', admitted: ADMIN },
  { route: 'PATCH /members/:userId', url: '/members/user_x', admitted: ADMIN },
  { route: 'DELETE /members/:userId', url: '/members/user_x', admitted: ADMIN },
  { route: 'GET /annotate/panels', url: '/annotate/panels', admitted: ANNOTATORS },
  {
    route: 'GET /annotate/panels/:slug/next',
    url: '/annotate/panels/some-panel/next',
    admitted: ANNOTATORS,
  },
  {
    route: 'GET /annotate/panels/:slug/previous',
    url: '/annotate/panels/some-panel/previous',
    admitted: ANNOTATORS,
  },
  { route: 'POST /annotate/annotations', url: '/annotate/annotations', admitted: ANNOTATORS },
  /**
   * CURATING IS STAFF, and an ANNOTATOR IS REFUSED — which is the row worth reading (ADR-0083).
   * Choosing what somebody's afternoon is spent on is not the same act as spending it, and
   * assigning a set grants its traces to whoever is named.
   */
  {
    route: 'GET /panels/:slug/annotation-sets',
    url: '/panels/some-panel/annotation-sets',
    admitted: STAFF,
  },
  {
    route: 'POST /panels/:slug/annotation-sets',
    url: '/panels/some-panel/annotation-sets',
    admitted: STAFF,
  },
  {
    route: 'POST /annotation-sets/:id/top-up',
    url: '/annotation-sets/aset_x/top-up',
    admitted: STAFF,
  },
  {
    route: 'PUT /annotation-sets/:id/annotators',
    url: '/annotation-sets/aset_x/annotators',
    admitted: STAFF,
  },
  {
    route: 'POST /annotation-sets/:id/archive',
    url: '/annotation-sets/aset_x/archive',
    admitted: STAFF,
  },
]

const send = (role: OrgRole, { route, url }: RouteCase) => {
  const method = route.split(' ')[0] ?? 'GET'
  return hostWith(role).request(`/probe${url}`, {
    method,
    ...(method === 'POST' || method === 'PATCH' || method === 'PUT'
      ? { body: '{}', headers: { 'content-type': 'application/json' } }
      : {}),
  })
}

const codeOf = async (response: Response) =>
  errorEnvelopeSchema.safeParse(
    await response
      .clone()
      .json()
      .catch(() => undefined),
  ).data?.error.code

describe('the role × route matrix', () => {
  const cases = MATRIX.flatMap((row) => ROLES.map((role) => [row.route, role, row] as const))

  test.each(cases)('%s as %s', async (_route, role, row) => {
    const response = await send(role, row)
    if (row.admitted.includes(role)) {
      expect(response.status).not.toBe(403)
      expect(await codeOf(response)).not.toBe('FORBIDDEN')
    } else {
      expect(response.status).toBe(403)
      expect(await codeOf(response)).toBe('FORBIDDEN')
    }
  })

  test('the matrix names every route those files register, and nothing else', () => {
    const registered = new Set(
      guardedRoutes()
        .routes.filter((r) => r.method !== 'ALL')
        .map((r) => `${r.method} ${r.path}`),
    )
    expect([...registered].sort()).toEqual(MATRIX.map((row) => row.route).sort())
  })
})

describe('what a refused caller is told', () => {
  const KEYS = MATRIX.find((row) => row.route === 'GET /keys') as RouteCase
  const PANELS = MATRIX.find((row) => row.route === 'POST /panels') as RouteCase

  test('the taxonomy code and the standard envelope', async () => {
    const response = await send('annotator', KEYS)

    expect(response.status).toBe(403)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('FORBIDDEN')
    expect(parsed.data?.request_id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('the message does not enumerate what the caller lacks', async () => {
    const response = await send('annotator', KEYS)
    const message = errorEnvelopeSchema.safeParse(await response.json()).data?.error.message ?? ''

    // Naming a role or a capability tells a caller exactly what to go and acquire. The console
    // already knows the caller's role from `/internal/me` and reads the same capability map.
    for (const word of [...ROLES, 'key', 'issue', 'read', 'panel', 'create']) {
      expect(message).not.toContain(word)
    }
  })

  test('every refusal is the SAME message, whatever the route required', async () => {
    const messageOf = async (response: Response) =>
      errorEnvelopeSchema.safeParse(await response.json()).data?.error.message

    const atKeys = await messageOf(await send('annotator', KEYS))
    const atPanels = await messageOf(await send('guest_expert', PANELS))
    expect(atKeys).toBeString()
    expect(atPanels).toBe(atKeys ?? '')
  })
})
