import { beforeEach, describe, expect, test } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { ATTR_HTTP_ROUTE } from '@opentelemetry/semantic-conventions'
import { Hono } from 'hono'
import { createFixedClock } from './adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from './adapters/noop-error-reporter.ts'
import { createApp } from './app.ts'
import type { AppEnv } from './app-env.ts'
import { type Config, loadConfig } from './config.ts'
import {
  METRIC_JUDGE_ATTEMPTS,
  METRIC_JUDGE_BREAKER_STATE,
  METRIC_JUDGE_CALLS,
  METRIC_JUDGE_COST_USD,
  METRIC_JUDGE_DURATION,
  METRIC_JUDGE_INPUT_TOKENS,
  METRIC_JUDGE_OUTPUT_TOKENS,
} from './llm/attributes.ts'
import { createFakeProvider, createModelGateway, FAKE_MODEL, FAKE_SENTINELS } from './llm/index.ts'
import {
  METRIC_HTTP_SERVER_DURATION,
  METRIC_HTTP_SERVER_REQUESTS,
  METRIC_RATE_LIMIT_DECISIONS,
  METRIC_RATE_LIMIT_FAIL_OPEN,
} from './metrics.ts'
import { byApiKey, rateLimit } from './middleware/rate-limit.ts'
import type { RateLimitStore } from './ports/rate-limit-store.ts'
import { createMemoryRateLimitStore } from './rate-limit/memory-store.ts'
import { fakeAuth } from './testing/fake-auth.ts'
import { fakeDatabase } from './testing/fake-database.ts'
import { fakeQueue } from './testing/fake-queue.ts'
import { recordingMetrics } from './testing/recording-metrics.ts'

/**
 * The instruments, asserted on the paths that actually produce them.
 *
 * Written against a REAL `MeterProvider` collecting into memory rather than against a
 * fake meter, for the reason `recording-spans.ts` gives about tracers: the interesting
 * question is what the SDK aggregates — which series exist, what is on them — and a fake
 * would answer whatever it was programmed to.
 *
 * Every case here drives the real funnel rather than calling an instrument directly. That
 * is the whole point: "the counter increments when you increment it" is not a fact about
 * this service, and the three funnels (`middleware/tracing.ts`, `llm/index.ts`,
 * `middleware/rate-limit.ts`) are exactly where an outcome gets forgotten.
 */

const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

const noopTracer = trace.getTracer('test')

let recorded: ReturnType<typeof recordingMetrics>
let reporter: ReturnType<typeof createRecordingErrorReporter>

beforeEach(() => {
  recorded = recordingMetrics()
  reporter = createRecordingErrorReporter()
})

/** The same fixture `llm/gateway.test.ts` uses, so both files judge the same thing. */
const CALL = {
  model: FAKE_MODEL,
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17.',
}

/** Capacity 1, so the second request is a refusal and nothing has to sleep. */
const POLICY = { capacity: 1, refillPerSecond: 1 }

const hostWith = (rateLimitStore: RateLimitStore = createMemoryRateLimitStore()) => {
  const app = createApp({
    config,
    clock: createFixedClock(),
    errorReporter: reporter,
    db: fakeDatabase(),
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock: createFixedClock(),
      tracer: noopTracer,
      meter: recorded.meter,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: recorded.meter,
    auth: fakeAuth(),
    rateLimitStore,
  })

  const probe = new Hono<AppEnv>()
  probe.use('/probe', async (c, next) => {
    c.set('apiKey', { id: 'key_probe', orgId: 'org_probe', panelId: 'pnl_probe' })
    await next()
  })
  probe.use('/probe', rateLimit({ subject: byApiKey, policy: POLICY }))
  probe.get('/probe', (c) => c.json({ ok: true }, 200))
  app.route('/probe-host', probe)
  return app
}

const gateway = () =>
  createModelGateway({
    provider: createFakeProvider(),
    clock: createFixedClock(),
    tracer: noopTracer,
    meter: recorded.meter,
  })

describe('the HTTP funnel', () => {
  test('records one duration and one request per call, labelled by route template', async () => {
    const app = hostWith()
    await app.request('/healthz')

    const duration = await recorded.named(METRIC_HTTP_SERVER_DURATION)
    const requests = await recorded.named(METRIC_HTTP_SERVER_REQUESTS)

    expect(duration?.series).toHaveLength(1)
    expect(duration?.series[0]?.count).toBe(1)
    expect(duration?.series[0]?.attributes).toMatchObject({
      'http.route': '/healthz',
      'http.request.method': 'GET',
      'labelloop.status_class': '2xx',
    })
    expect(requests?.series[0]?.value).toBe(1)
  })

  test('groups by the TEMPLATE, so ids do not become time series', async () => {
    const app = hostWith()
    // Two different panels: one route, and therefore one series. The alternative — the
    // raw path — is one series per panel id, forever, which is the failure this label
    // choice exists to prevent (ADR-0042).
    await app.request('/v1/panels/pnl_aaaaaaaaaaaaaaaaaaaaaaaaaa/evaluate', { method: 'POST' })
    await app.request('/v1/panels/pnl_bbbbbbbbbbbbbbbbbbbbbbbbbb/evaluate', { method: 'POST' })

    const requests = await recorded.named(METRIC_HTTP_SERVER_REQUESTS)
    const evaluate = requests?.series.filter(
      (series) => series.attributes[ATTR_HTTP_ROUTE] === '/v1/panels/:panel_id/evaluate',
    )
    expect(evaluate).toHaveLength(1)
    expect(evaluate?.[0]?.value).toBe(2)
  })

  test('a 404 is one series, not one per URL a stranger tried', async () => {
    const app = hostWith()
    await app.request('/nope')
    await app.request('/also-nope')
    await app.request('/definitely-not-here')

    const requests = await recorded.named(METRIC_HTTP_SERVER_REQUESTS)
    const unmatched = requests?.series.filter(
      (series) => series.attributes[ATTR_HTTP_ROUTE] === '/*',
    )
    expect(unmatched).toHaveLength(1)
    expect(unmatched?.[0]?.value).toBe(3)
  })
})

describe('the judge funnel', () => {
  test('an evaluated call records duration, tokens, cost and attempts', async () => {
    const outcome = await gateway().judge({ ...CALL }, { slug: 'is-fine' })
    expect(outcome.status).toBe('evaluated')

    const calls = await recorded.named(METRIC_JUDGE_CALLS)
    expect(calls?.series[0]?.value).toBe(1)
    expect(calls?.series[0]?.attributes).toMatchObject({
      'gen_ai.request.model': FAKE_MODEL,
      'labelloop.outcome': 'evaluated',
      'labelloop.judge_slug': 'is-fine',
    })

    expect((await recorded.named(METRIC_JUDGE_DURATION))?.series[0]?.count).toBe(1)
    expect((await recorded.named(METRIC_JUDGE_ATTEMPTS))?.series[0]?.value).toBe(1)
    expect((await recorded.named(METRIC_JUDGE_INPUT_TOKENS))?.series[0]?.value).toBeGreaterThan(0)
    expect((await recorded.named(METRIC_JUDGE_OUTPUT_TOKENS))?.series[0]?.value).toBeGreaterThan(0)
  })

  test('cost carries `cost_priced`, so free and unpriced are never summed as spend', async () => {
    await gateway().judge({ ...CALL }, { slug: 'is-fine' })

    const cost = await recorded.named(METRIC_JUDGE_COST_USD)
    // The label is the whole point of the metric existing separately from a plain total:
    // M0's fake genuinely costs nothing and an unpriced model reports nothing, and a
    // dashboard that added them together would understate real spend.
    // Bracketed, because the attribute NAME contains dots and a bare string would be read
    // as a path into nested objects.
    expect(cost?.series[0]?.attributes['labelloop.cost_priced']).toBeBoolean()
    // And the model that ANSWERED, not the one requested: a provider that aliases bills
    // for what it served, so a cost series labelled with the ask attributes spend to a
    // model that never ran.
    expect(cost?.series[0]?.attributes).toMatchObject({ 'gen_ai.response.model': FAKE_MODEL })
  })

  test('a failed call is counted with its outcome rather than not counted', async () => {
    // The trap this guards: five ways out of `judge()`, and a metric recorded only on the
    // happy path makes a broken provider look like an idle one.
    const outcome = await gateway().judge(
      { ...CALL, artifact: `${FAKE_SENTINELS.invalidOutput} garbage` },
      { slug: 'is-fine' },
    )
    expect(outcome.status).not.toBe('evaluated')

    const calls = await recorded.named(METRIC_JUDGE_CALLS)
    expect(calls?.series).toHaveLength(1)
    expect(calls?.series[0]?.attributes['labelloop.outcome']).toBe(outcome.status)
  })

  test('the breaker gauge reports a state per model once a model has been called', async () => {
    await gateway().judge({ ...CALL })

    const breaker = await recorded.named(METRIC_JUDGE_BREAKER_STATE)
    expect(breaker?.series).toHaveLength(1)
    // Closed, and — because the instrument is OBSERVABLE — reported on this collection
    // rather than at the moment the breaker last changed. A gauge that only spoke on
    // change would go silent for exactly as long as something stayed broken.
    expect(breaker?.series[0]?.value).toBe(0)
    expect(breaker?.series[0]?.attributes).toMatchObject({ 'gen_ai.request.model': FAKE_MODEL })
  })
})

describe('the rate-limit funnel', () => {
  test('counts a refusal under `refused` and a served request under `allowed`', async () => {
    const app = hostWith()
    expect((await app.request('/probe-host/probe')).status).toBe(200)
    expect((await app.request('/probe-host/probe')).status).toBe(429)

    const decisions = await recorded.named(METRIC_RATE_LIMIT_DECISIONS)
    const by = (decision: string) =>
      decisions?.series.find((series) => series.attributes['labelloop.decision'] === decision)
    expect(by('allowed')?.value).toBe(1)
    expect(by('refused')?.value).toBe(1)
  })

  test('a fail-open increments its own counter — the half of ADR-0040 that is visible', async () => {
    const broken: RateLimitStore = {
      consume: async () => {
        throw new Error('redis is unreachable')
      },
      close: async () => {},
    }
    const app = hostWith(broken)
    expect((await app.request('/probe-host/probe')).status).toBe(200)

    // Without this number a fail-open is a warning in a log stream nobody is reading:
    // the service serves everything, unlimited, and looks healthy from outside.
    expect((await recorded.named(METRIC_RATE_LIMIT_FAIL_OPEN))?.series[0]?.value).toBe(1)
    // And still counted as served, so the two rate-limit metrics agree about how many
    // requests the limiter saw.
    const decisions = await recorded.named(METRIC_RATE_LIMIT_DECISIONS)
    expect(decisions?.series[0]?.attributes['labelloop.decision']).toBe('allowed')
  })
})
