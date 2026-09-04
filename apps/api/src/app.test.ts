import { beforeEach, describe, expect, test } from 'bun:test'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorEnvelopeSchema, requestIdSchema } from '@labelloop/contracts'
import { trace } from '@opentelemetry/api'
import { createFixedClock } from './adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from './adapters/noop-error-reporter.ts'
import { createApp } from './app.ts'
import { type Config, loadConfig } from './config.ts'
import { AppError } from './errors.ts'
import { createFakeProvider, createModelGateway } from './llm/index.ts'
import { REQUEST_ID_HEADER } from './middleware/request-context.ts'
import { createMemoryRateLimitStore } from './rate-limit/memory-store.ts'
import { validationHook } from './routes/public/v1/index.ts'
import { fakeAuth } from './testing/fake-auth.ts'
import { fakeDatabase } from './testing/fake-database.ts'
import { fakeQueue } from './testing/fake-queue.ts'

/**
 * The integration test builds the REAL app through its composition root and swaps only
 * the outside world. Nothing is monkey-patched and no route is stubbed — what runs here
 * is what runs in production, minus the network (CONVENTIONS.md "Dependency seams").
 */
const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  APP_VERSION: '9.9.9',
  GIT_SHA: 'deadbee',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

/**
 * None of the tests in this file evaluate anything — they are about routing, the envelope
 * and the logger — so the gateway here exists only to satisfy the composition root. The
 * evaluation path has its own integration test, against a real database.
 */
/**
 * OTel's global tracer with no provider registered: a real object with a no-op
 * implementation. Passing it is what these tests want to say — this file is about routing,
 * the envelope and the logger, and it deliberately proves the app still works when nothing
 * is tracing. `otel.test.ts` and `middleware/tracing.test.ts` own the spans.
 */
const noopTracer = trace.getTracer('test')

const testGateway = () =>
  createModelGateway({
    provider: createFakeProvider(),
    clock: createFixedClock(),
    tracer: noopTracer,
  })

let reporter: ReturnType<typeof createRecordingErrorReporter>
let app: ReturnType<typeof createApp>

beforeEach(() => {
  reporter = createRecordingErrorReporter()
  app = createApp({
    config,
    clock: createFixedClock(),
    errorReporter: reporter,
    db: fakeDatabase(),
    modelGateway: testGateway(),
    jobs: fakeQueue(),
    tracer: noopTracer,
    auth: fakeAuth(),
    rateLimitStore: createMemoryRateLimitStore(),
  })
})

describe('/healthz', () => {
  test('reports liveness plus the build it is running (ADR-0011)', async () => {
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: Record<string, unknown>; request_id: string }
    expect(body.data.status).toBe('ok')
    expect(body.data.version).toBe('9.9.9')
    expect(body.data.git_sha).toBe('deadbee')
    expect(typeof body.data.uptime_s).toBe('number')
  })
})

describe('the envelope holds on every path (ADR-0010)', () => {
  test.each([
    ['/healthz', 200],
    ['/_demo/rate-limited', 429],
    ['/_demo/boom', 500],
    ['/no/such/route', 404],
  ])('%s carries a request_id matching its header', async (path, status) => {
    const res = await app.request(path)
    expect(res.status).toBe(status)
    const body = (await res.json()) as { request_id: string }
    expect(requestIdSchema.safeParse(body.request_id).success).toBe(true)
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.request_id)
  })

  test('two requests get two different ids', async () => {
    const [a, b] = await Promise.all([app.request('/healthz'), app.request('/healthz')])
    expect(await a.json()).not.toEqual(await b.json())
  })
})

describe('the central error handler', () => {
  test('an unmatched route is a NOT_FOUND envelope, not Hono’s default text', async () => {
    const res = await app.request('/no/such/route')
    expect(res.status).toBe(404)
    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('NOT_FOUND')
  })

  test('/_demo/rate-limited is a 429 with a Retry-After header', async () => {
    const res = await app.request('/_demo/rate-limited')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('30')
    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('RATE_LIMITED')
  })

  test('/_demo/boom leaks nothing: generic message, no stack, no original text', async () => {
    const res = await app.request('/_demo/boom')
    expect(res.status).toBe(500)
    const raw = await res.text()
    expect(raw).not.toContain('synthetic failure')
    expect(raw).not.toContain('at ')
    const parsed = errorEnvelopeSchema.safeParse(JSON.parse(raw))
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('INTERNAL')
  })

  test('the 500 path reports the ORIGINAL error to the tracker, with its request_id', async () => {
    const res = await app.request('/_demo/boom')
    const { request_id } = (await res.json()) as { request_id: string }
    expect(reporter.reports).toHaveLength(1)
    const report = reporter.reports[0]
    if (report === undefined) throw new Error('expected a report')
    expect(report.requestId).toBe(request_id)
    expect((report.error as Error).message).toBe('synthetic failure from /_demo/boom')
    expect(report.context).toMatchObject({ code: 'INTERNAL', path: '/_demo/boom' })
  })

  test('an EXPECTED error is not reported — planned outcomes do not page anyone', async () => {
    await app.request('/_demo/rate-limited')
    await app.request('/no/such/route')
    expect(reporter.reports).toHaveLength(0)
  })
})

describe('the versioned public surface', () => {
  test('serves an OpenAPI document naming the running version', async () => {
    const res = await app.request('/v1/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { info: { version: string }; components?: unknown }
    expect(doc.info.version).toBe('9.9.9')
  })

  test('registers the API-key security scheme so Scalar can call the API (ADR-0002)', async () => {
    const res = await app.request('/v1/openapi.json')
    const doc = (await res.json()) as {
      components: { securitySchemes: Record<string, { type: string; scheme?: string }> }
    }
    expect(doc.components.securitySchemes.apiKey).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    })
  })

  test('renders the Scalar reference at /v1/docs', async () => {
    const res = await app.request('/v1/docs')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })

  test('the demo routes are absent from the published spec (ADR-0015)', async () => {
    const res = await app.request('/v1/openapi.json')
    expect(JSON.stringify(await res.json())).not.toContain('_demo')
  })
})

describe('contract-validation auto-mapping', () => {
  /**
   * P4 proves this on the real classify endpoint. What is proven here is the *mechanism*
   * — that the hook every `createRoute` inherits turns a schema failure into the
   * `VALIDATION_ERROR` envelope with field detail — without publishing a throwaway route
   * into the versioned spec to do it.
   */
  const withValidatedRoute = () => {
    const probe = new OpenAPIHono({ defaultHook: validationHook as never })
    probe.openapi(
      createRoute({
        method: 'post',
        path: '/probe',
        request: {
          body: {
            content: { 'application/json': { schema: z.object({ input: z.string().min(1) }) } },
          },
        },
        responses: { 200: { description: 'ok' } },
      }),
      (c) => c.json({ ok: true }, 200),
    )
    const host = createApp({
      config,
      clock: createFixedClock(),
      errorReporter: reporter,
      db: fakeDatabase(),
      modelGateway: testGateway(),
      jobs: fakeQueue(),
      tracer: noopTracer,
      auth: fakeAuth(),
      rateLimitStore: createMemoryRateLimitStore(),
    })
    host.route('/probe-host', probe)
    return host
  }

  test('a malformed body becomes VALIDATION_ERROR with field-level issues', async () => {
    const res = await withValidatedRoute().request('/probe-host/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '' }),
    })
    expect(res.status).toBe(422)
    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('VALIDATION_ERROR')
    expect(parsed.data?.error.issues?.[0]?.path).toBe('input')
  })

  test('a validation failure is not reported to the tracker', async () => {
    await withValidatedRoute().request('/probe-host/probe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(reporter.reports).toHaveLength(0)
  })
})

describe('validationHook', () => {
  test('does nothing on success and throws AppError on failure', () => {
    expect(() => validationHook({ success: true })).not.toThrow()
    try {
      validationHook({
        success: false,
        error: { issues: [{ path: ['body', 'input'], message: 'Required' }] },
      })
      throw new Error('expected a throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).issues).toEqual([{ path: 'body.input', message: 'Required' }])
    }
  })
})

describe('/readyz', () => {
  /**
   * Readiness is a different question from liveness, and the split is what stops a
   * database blip from becoming a restart storm: `/healthz` stays up so the container is
   * not killed, `/readyz` goes red so traffic stops arriving.
   */
  const withDependencies = (
    options: Parameters<typeof fakeDatabase>[0],
    queue: Parameters<typeof fakeQueue>[0] = {},
  ) =>
    createApp({
      config,
      clock: createFixedClock(),
      errorReporter: reporter,
      db: fakeDatabase(options),
      modelGateway: testGateway(),
      jobs: fakeQueue(queue),
      tracer: noopTracer,
      auth: fakeAuth(),
      rateLimitStore: createMemoryRateLimitStore(),
    })

  const withDatabase = (options: Parameters<typeof fakeDatabase>[0]) => withDependencies(options)

  test('reports ready when the database answers and migrations are current', async () => {
    const res = await withDatabase({}).request('/readyz')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { status: string; checks: Array<{ name: string; ok: boolean }> }
      request_id: string
    }
    expect(body.data.status).toBe('ready')
    expect(body.data.checks).toEqual([
      { name: 'database', ok: true },
      { name: 'migrations', ok: true },
      { name: 'queue', ok: true },
    ])
    expect(requestIdSchema.safeParse(body.request_id).success).toBe(true)
  })

  test('an unreachable database is a 503 that NAMES the failing check', async () => {
    const res = await withDatabase({ failing: new Error('connection refused') }).request('/readyz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      data: { status: string; checks: Array<{ name: string; ok: boolean; detail?: string }> }
    }
    expect(body.data.status).toBe('unready')
    // Naming the check is the entire value of the body — "unready" alone sends whoever is
    // paged to look at everything at once.
    const failed = body.data.checks.filter((check) => !check.ok).map((check) => check.name)
    expect(failed).toEqual(['database', 'migrations'])
    expect(body.data.checks[0]?.detail).toContain('connection refused')
  })

  test('a reachable database with migrations behind is still NOT ready', async () => {
    /**
     * The case that motivates checking migrations at all: Postgres is perfectly healthy,
     * so a reachability-only probe reports ready — and the container serves this release's
     * code against last release's schema, which is a rolling deploy quietly answering
     * wrongly rather than failing.
     */
    const res = await withDatabase({ applied: 0 }).request('/readyz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      data: { checks: Array<{ name: string; ok: boolean; detail?: string }> }
    }
    expect(body.data.checks.find((check) => check.name === 'database')?.ok).toBe(true)
    const migrations = body.data.checks.find((check) => check.name === 'migrations')
    expect(migrations?.ok).toBe(false)
    expect(migrations?.detail).toContain('db:migrate')
  })

  test('a database that never answers times out rather than hanging the probe', async () => {
    // A readiness probe that hangs is worse than one that fails: the orchestrator waits
    // on it, and nothing is ever marked unhealthy.
    const res = await withDatabase({ hanging: true }).request('/readyz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      data: { checks: Array<{ name: string; ok: boolean; detail?: string }> }
    }
    // The queue is fine here; the point is that the DB checks END rather than hang.
    const failed = body.data.checks.filter((check) => !check.ok)
    expect(failed.map((check) => check.name)).toEqual(['database', 'migrations'])
    expect(failed[0]?.detail).toContain('timed out')
  }, 10_000)

  test('an unresponsive QUEUE is unready too, and named', async () => {
    /**
     * A queue nobody can reach is invisible from the caller's side: evaluations keep
     * answering, and every one of their follow-ups piles up unrun. Readiness is the only
     * place that failure shows up before the backlog does.
     */
    const res = await withDependencies(
      {},
      { unhealthy: new Error('queue(s) not installed') },
    ).request('/readyz')
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      data: { status: string; checks: Array<{ name: string; ok: boolean; detail?: string }> }
    }
    expect(body.data.status).toBe('unready')
    const failed = body.data.checks.filter((check) => !check.ok)
    expect(failed.map((check) => check.name)).toEqual(['queue'])
    expect(failed[0]?.detail).toContain('not installed')
  })

  test('/healthz stays up when the database is down — liveness is not readiness', async () => {
    const app = withDatabase({ failing: new Error('connection refused') })
    expect((await app.request('/healthz')).status).toBe(200)
    expect((await app.request('/readyz')).status).toBe(503)
  })
})
