import { beforeEach, describe, expect, test } from 'bun:test'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { errorEnvelopeSchema, requestIdSchema } from '@labelloop/contracts'
import { createFixedClock } from './adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from './adapters/noop-error-reporter.ts'
import { createApp } from './app.ts'
import { type Config, loadConfig } from './config.ts'
import { AppError } from './errors.ts'
import { REQUEST_ID_HEADER } from './middleware/request-context.ts'
import { validationHook } from './routes/public/v1/index.ts'

/**
 * The integration test builds the REAL app through its composition root and swaps only
 * the outside world. Nothing is monkey-patched and no route is stubbed — what runs here
 * is what runs in production, minus the network (CONVENTIONS.md "Dependency seams").
 */
const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  APP_VERSION: '9.9.9',
  GIT_SHA: 'deadbee',
})

let reporter: ReturnType<typeof createRecordingErrorReporter>
let app: ReturnType<typeof createApp>

beforeEach(() => {
  reporter = createRecordingErrorReporter()
  app = createApp({ config, clock: createFixedClock(), errorReporter: reporter })
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
    const host = createApp({ config, clock: createFixedClock(), errorReporter: reporter })
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
