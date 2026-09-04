import { beforeEach, describe, expect, test } from 'bun:test'
import { context } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { Hono } from 'hono'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../adapters/noop-error-reporter.ts'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { AppError, toAppError } from '../errors.ts'
import { createFakeProvider, createModelGateway } from '../llm/index.ts'
import { createMemoryRateLimitStore } from '../rate-limit/memory-store.ts'
import { fakeAuth } from '../testing/fake-auth.ts'
import { fakeDatabase } from '../testing/fake-database.ts'
import { fakeQueue } from '../testing/fake-queue.ts'
import { recordingSpans } from '../testing/recording-spans.ts'
import { createRootLogger, httpLogger } from './logger.ts'
import { REQUEST_ID_HEADER, requestContext } from './request-context.ts'
import { tracing } from './tracing.ts'

/**
 * The request span, and the identity that comes out of it.
 *
 * A context manager is installed here — the ONE process global this file touches — because
 * `context.with` is a no-op without one, and everything below depends on the span actually
 * being active for the middlewares that follow. The tracer is passed in rather than
 * registered globally, so no other test file inherits a tracer that suddenly records.
 */
const contextManager = new AsyncLocalStorageContextManager()
contextManager.enable()
context.setGlobalContextManager(contextManager)

const config = loadConfig({
  LOG_LEVEL: 'info',
  APP_VERSION: '9.9.9',
  GIT_SHA: 'deadbee',
  DATABASE_URL: 'postgres://labelloop_app:localdev@localhost:5433/labelloop',
})

let spans: ReturnType<typeof recordingSpans>
beforeEach(() => {
  spans = recordingSpans()
})

/**
 * The three middlewares `app.ts` mounts, in the order it mounts them, plus a route that
 * answers with the standard envelope. Hand-composed rather than via `createApp` for one
 * reason: the root logger's destination is not an injectable dependency, and the log line
 * is one of the four things that have to agree.
 */
const chain = () => {
  const lines: Array<Record<string, unknown>> = []
  const logger = createRootLogger(config, {
    write: (line: string) => {
      lines.push(JSON.parse(line) as Record<string, unknown>)
    },
  })
  const app = new Hono<{ Variables: { requestId: string } }>()
    .use('*', tracing(spans.tracer))
    .use('*', requestContext())
    .use('*', httpLogger(logger))
    .get('/ping', (c) => c.json({ data: { ok: true }, request_id: c.var.requestId }))
    .get('/panels/:id/evaluate', (c) => c.json({ data: {}, request_id: c.var.requestId }))
    .get('/boom', () => {
      throw new Error('unexpected')
    })
    .get('/refused', () => {
      throw new AppError('UNAUTHORIZED', 'No.')
    })
  // The same mapping `app.ts` uses, so the statuses these spans record are the statuses a
  // caller would actually have seen.
  app.onError((error, c) => {
    const { appError } = toAppError(error)
    return c.json({ error: { code: appError.code } }, appError.status as 401 | 500)
  })
  return { app, lines }
}

describe('the request span', () => {
  test('is one SERVER span per request, named for the route template', async () => {
    await chain().app.request('/panels/pnl_01ABC/evaluate')

    const [span] = spans.spans()
    expect(spans.spans()).toHaveLength(1)
    // The id is in `url.path` and NOT in the name. A span named for the concrete path
    // gives every request its own row in a trace list, which makes the list useless.
    expect(span?.name).toBe('GET /panels/:id/evaluate')
    expect(span?.attributes).toMatchObject({
      'http.request.method': 'GET',
      'http.route': '/panels/:id/evaluate',
      'url.path': '/panels/pnl_01ABC/evaluate',
      'http.response.status_code': 200,
    })
  })

  test('records neither the query string nor any header', async () => {
    await chain().app.request('/ping?email=ada@example.com', {
      headers: { authorization: 'Bearer llk_live_EXAMPLE_NOT_A_REAL_KEY' },
    })

    const attributes = JSON.stringify(spans.spans()[0]?.attributes)
    expect(attributes).not.toContain('ada@example.com')
    expect(attributes).not.toContain('EXAMPLE_NOT_A_REAL_KEY')
  })
})

describe('request_id, the log line, the envelope and the span', () => {
  test('are one and the same string (ADR-0010)', async () => {
    const { app, lines } = chain()

    const response = await app.request('/ping')
    const body = (await response.json()) as { request_id: string }
    const [span] = spans.spans()

    // The whole point of P6's seam, in one assertion: paste the id a caller was given into
    // Tempo and the trace is there, because it is not a parallel identifier that happens
    // to look alike — it is the trace id.
    expect(
      new Set([
        body.request_id,
        response.headers.get(REQUEST_ID_HEADER),
        span?.spanContext().traceId,
        lines[0]?.request_id,
      ]),
    ).toEqual(new Set([span?.spanContext().traceId]))
    expect(body.request_id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('differs per request, so two calls are two traces', async () => {
    const { app } = chain()
    await app.request('/ping')
    await app.request('/ping')

    const [first, second] = spans.spans()
    expect(first?.spanContext().traceId).not.toBe(second?.spanContext().traceId)
  })

  test('holds through the REAL composition root, not only this file s chain', async () => {
    const app = createApp({
      // Silent: this one goes through the real root logger, whose destination is not
      // injectable, and a test suite should not print request lines.
      config: { ...config, LOG_LEVEL: 'silent' },
      clock: createFixedClock(),
      errorReporter: createRecordingErrorReporter(),
      db: fakeDatabase(),
      modelGateway: createModelGateway({
        provider: createFakeProvider(),
        clock: createFixedClock(),
        tracer: spans.tracer,
      }),
      jobs: fakeQueue(),
      tracer: spans.tracer,
      auth: fakeAuth(),
      rateLimitStore: createMemoryRateLimitStore(),
    })

    const response = await app.request('/healthz')
    const body = (await response.json()) as { request_id: string }
    expect(body.request_id).toBe(spans.spans()[0]?.spanContext().traceId ?? '')
  })
})

describe('the span status', () => {
  test('is ERROR for a 500, and the status code is on the span', async () => {
    await chain().app.request('/boom')

    const [span] = spans.spans()
    expect(span?.attributes['http.response.status_code']).toBe(500)
    // 2 is SpanStatusCode.ERROR. Asserted numerically because that is what the exporter
    // sends and what Tempo colours on.
    expect(span?.status.code).toBe(2)
  })

  test('is NOT error for a 401 — a rejected caller is the API working', async () => {
    await chain().app.request('/refused')

    const [span] = spans.spans()
    expect(span?.attributes['http.response.status_code']).toBe(401)
    // 0 is UNSET. Marking client errors red is how a dashboard becomes background noise.
    expect(span?.status.code).toBe(0)
  })

  test('omits http.route entirely when nothing matched', async () => {
    await chain().app.request('/no-such-path')

    const [span] = spans.spans()
    // Hono reports `/*` for an unmatched request, which is not a route template — recording
    // it would put a meaningless value into the field metrics group by.
    expect(span?.attributes['http.route']).toBeUndefined()
    expect(span?.name).toBe('GET')
    expect(span?.attributes['http.response.status_code']).toBe(404)
  })
})
