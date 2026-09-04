import { beforeEach, describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema } from '@labelloop/contracts'
import { trace } from '@opentelemetry/api'
import { Hono } from 'hono'
import { createFixedClock, type FixedClock } from '../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../adapters/noop-error-reporter.ts'
import { createApp } from '../app.ts'
import type { AppEnv } from '../app-env.ts'
import { type Config, loadConfig } from '../config.ts'
import { createFakeProvider, createModelGateway } from '../llm/index.ts'
import type { RateLimitStore } from '../ports/rate-limit-store.ts'
import { createMemoryRateLimitStore } from '../rate-limit/memory-store.ts'
import { fakeAuth } from '../testing/fake-auth.ts'
import { fakeDatabase } from '../testing/fake-database.ts'
import { fakeQueue } from '../testing/fake-queue.ts'
import { apiKeyAuth } from './api-key-auth.ts'
import { byApiKey, rateLimit } from './rate-limit.ts'

/**
 * The limiter as a caller meets it: through the REAL composition root and the REAL central
 * error handler, so the 429 envelope and its `Retry-After` are the ones `app.ts` actually
 * serializes rather than a copy of them. A probe route is mounted onto the built app —
 * the pattern `app.test.ts` uses for the validation hook — because publishing a throwaway
 * route into the versioned spec to test middleware would be worse than the duplication it
 * saves.
 *
 * The bucket arithmetic itself is not re-asserted here; `rate-limit/token-bucket.test.ts`
 * owns that. What this file owns is the three things only the middleware decides: what the
 * caller is told, what happens when the store is broken, and the ORDER.
 */

const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

const noopTracer = trace.getTracer('test')

/** A store that remembers whether it was asked anything — the "consumes nothing" assertion. */
const countingStore = (inner: RateLimitStore = createMemoryRateLimitStore()) => {
  let consumes = 0
  const store: RateLimitStore & { readonly consumes: () => number } = {
    consume: (request) => {
      consumes += 1
      return inner.consume(request)
    },
    close: () => inner.close(),
    consumes: () => consumes,
  }
  return store
}

/** A store that is broken the way a Redis outage is broken: every call rejects. */
const brokenStore = (error = new Error('redis is unreachable')): RateLimitStore => ({
  consume: async () => {
    throw error
  },
  close: async () => {},
})

/** Capacity 2 so exhaustion is two requests, and the refill boundary is a clean second. */
const POLICY = { capacity: 2, refillPerSecond: 1 }

let reporter: ReturnType<typeof createRecordingErrorReporter>
let clock: FixedClock

beforeEach(() => {
  reporter = createRecordingErrorReporter()
  clock = createFixedClock()
})

/**
 * The real app, with a probe route behind the middleware under test. `middleware` is passed
 * as a chain so the ORDER is the thing being exercised, exactly as `evaluate.ts` declares it.
 */
const hostWith = (
  rateLimitStore: RateLimitStore,
  { authenticated = true }: { authenticated?: boolean } = {},
) => {
  const app = createApp({
    config,
    clock,
    errorReporter: reporter,
    db: fakeDatabase(),
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock: createFixedClock(),
      tracer: noopTracer,
    }),
    jobs: fakeQueue(),
    tracer: noopTracer,
    auth: fakeAuth(),
    rateLimitStore,
  })

  const probe = new Hono<AppEnv>()
  // Either the REAL key auth — which turns an unauthenticated request away before the
  // limiter is reached — or a stand-in that establishes a key without a database, for the
  // cases that are about the bucket rather than about authentication.
  probe.use(
    '/probe',
    authenticated
      ? async (c, next) => {
          c.set('apiKey', { id: 'key_probe', orgId: 'org_probe', panelId: 'pnl_probe' })
          await next()
        }
      : apiKeyAuth('panel_id'),
  )
  probe.use('/probe', rateLimit({ subject: byApiKey, policy: POLICY }))
  probe.get('/probe', (c) => c.json({ ok: true }, 200))

  app.route('/probe-host', probe)
  return app
}

const call = (app: ReturnType<typeof hostWith>) => app.request('/probe-host/probe')

describe('the 429 a limited caller actually receives', () => {
  test('serves up to `capacity`, then refuses with the taxonomy code and status', async () => {
    const app = hostWith(createMemoryRateLimitStore())
    for (let i = 0; i < POLICY.capacity; i++) expect((await call(app)).status).toBe(200)

    const refused = await call(app)
    expect(refused.status).toBe(429)

    const parsed = errorEnvelopeSchema.safeParse(await refused.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('RATE_LIMITED')
    // Every response carries one, success or failure (ADR-0010).
    expect(parsed.data?.request_id).toMatch(/^[0-9a-f]{32}$/)
  })

  test('carries `Retry-After`, and the number comes from the BUCKET rather than a constant', async () => {
    const app = hostWith(createMemoryRateLimitStore())
    for (let i = 0; i < POLICY.capacity; i++) await call(app)

    // Empty: one token is a second away, so the header says 1.
    expect((await call(app)).headers.get('retry-after')).toBe('1')

    // The proof that it is computed and not a literal: half a second of refill later the
    // bucket still cannot serve a whole request, and the honest answer is a SHORTER wait
    // than a constant would give. Rounded up, because `Retry-After` is whole seconds and a
    // 500ms wait expressed as 0 is an invitation to hammer.
    clock.advance(500)
    expect((await call(app)).headers.get('retry-after')).toBe('1')

    // And once the token has actually accrued, the request is served.
    clock.advance(500)
    expect((await call(app)).status).toBe(200)
  })

  test('the refusal is not reported to the error tracker — a limit working is not an incident', async () => {
    const app = hostWith(createMemoryRateLimitStore())
    for (let i = 0; i < POLICY.capacity + 1; i++) await call(app)
    // `AppError`s are PLANNED outcomes. Paging on them is how alert fatigue starts.
    expect(reporter.reports).toHaveLength(0)
  })
})

describe('the order: authentication first, then the limit', () => {
  test('an unauthenticated request is 401 and consumes NOTHING', async () => {
    // The assertion the whole ordering decision exists for (ADR-0040). Limiting first would
    // let anyone with no key at all — flooding a guessed panel id — spend a real customer's
    // allowance, turning the limiter into the denial of service it is there to prevent.
    const store = countingStore()
    const app = hostWith(store, { authenticated: false })

    for (let i = 0; i < POLICY.capacity * 5; i++) {
      expect((await call(app)).status).toBe(401)
    }
    expect(store.consumes()).toBe(0)
  })

  test('and the key’s own allowance is untouched by that flood', async () => {
    // The same store, then a legitimate caller: the full burst is still theirs.
    const store = createMemoryRateLimitStore()
    const flooded = hostWith(store, { authenticated: false })
    for (let i = 0; i < POLICY.capacity * 5; i++) await call(flooded)

    const legitimate = hostWith(store)
    for (let i = 0; i < POLICY.capacity; i++) expect((await call(legitimate)).status).toBe(200)
  })
})

describe('when the store is broken, the limiter FAILS OPEN (ADR-0040)', () => {
  /**
   * Asserted directly, and that is the point of the test rather than an incidental detail:
   * this path only ever runs when something is already wrong, so an untested one is
   * discovered during the outage it exists for.
   */
  test('the request is SERVED rather than becoming a 500', async () => {
    const app = hostWith(brokenStore())
    // Well past the capacity. A broken limiter is our problem, not the caller's.
    for (let i = 0; i < POLICY.capacity * 3; i++) {
      expect((await call(app)).status).toBe(200)
    }
  })

  test('and says so — a fail-open limiter is invisible unless it is loud', async () => {
    const app = hostWith(brokenStore(new Error('ECONNREFUSED')))
    await call(app)

    // Reported, because during an outage there is no bound on traffic at all and nobody
    // would otherwise find out. The report names the component so it is attributable.
    expect(reporter.reports).toHaveLength(1)
    const report = reporter.reports[0]
    if (report === undefined) throw new Error('expected the fail-open path to report')
    expect(report.context?.component).toBe('rate-limit')
    expect(report.context?.subject).toBe('key:key_probe')
    expect((report.error as Error).message).toBe('ECONNREFUSED')
    // The join back to the log line and the span for that execution (ADR-0010).
    expect(report.requestId).toMatch(/^[0-9a-f]{32}$/)
  })

  test('recovery needs no restart — the next call through a healthy store limits again', async () => {
    let broken = true
    const inner = createMemoryRateLimitStore()
    const flaky: RateLimitStore = {
      consume: (request) => {
        if (broken) throw new Error('redis is unreachable')
        return inner.consume(request)
      },
      close: () => inner.close(),
    }

    const app = hostWith(flaky)
    for (let i = 0; i < POLICY.capacity * 3; i++) expect((await call(app)).status).toBe(200)

    broken = false
    for (let i = 0; i < POLICY.capacity; i++) expect((await call(app)).status).toBe(200)
    expect((await call(app)).status).toBe(429)
  })
})
