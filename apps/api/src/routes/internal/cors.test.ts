import { describe, expect, test } from 'bun:test'
import { metrics, trace } from '@opentelemetry/api'
import { createFixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { loadConfig } from '../../config.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { ACTIVE_ORG_HEADER } from '../../middleware/session.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import { fakeAuth } from '../../testing/fake-auth.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeDatabase } from '../../testing/fake-database.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * THE CONSOLE'S CORS ALLOW-LIST, ASSERTED AGAINST THE ROUTES THAT ACTUALLY EXIST.
 *
 * **This file exists because a missing method fails in a way nothing else here can see.** The
 * preflight is answered 204 whatever the method is; the browser then compares
 * `Access-Control-Allow-Methods` against the real request and drops it on its own, with no
 * server-side trace at all. `app.request()` sends no preflight, so every other test in this
 * repository stays green while the console silently cannot write.
 *
 * It cost the assign dialog exactly that (M5 phase 7): `PUT /annotation-sets/:id/annotators`
 * was the first PUT this API ever registered, the suite was green, and the button did nothing
 * in a real browser. The rule is now derived rather than remembered — every method the router
 * registers must be on the list, checked by asking the app for both.
 */

const config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
  WEB_ORIGIN: 'http://localhost:5173',
})

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

const app = () =>
  createApp({
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

const preflight = (method: string) =>
  app().request('http://localhost/internal/members', {
    method: 'OPTIONS',
    headers: {
      origin: config.WEB_ORIGIN,
      'access-control-request-method': method,
      'access-control-request-headers': `content-type,${ACTIVE_ORG_HEADER}`,
    },
  })

/** Every HTTP method any `/internal` route is registered under. */
const registeredMethods = (): string[] => {
  const internal = app().routes.filter((route) => route.path.startsWith('/internal'))
  return [...new Set(internal.map((route) => route.method))].filter(
    // Hono registers middleware as `ALL`; it is not a method a browser can ask for.
    (method) => method !== 'ALL',
  )
}

describe('the console CORS allow-list covers every method the router registers', () => {
  test('the scan found routes at all — a rule over zero routes proves nothing', () => {
    expect(registeredMethods().length).toBeGreaterThan(2)
  })

  test('every registered method is allowed by the preflight', async () => {
    const allowed = (await preflight('GET')).headers.get('access-control-allow-methods') ?? ''
    const listed = allowed.split(',').map((method) => method.trim().toUpperCase())
    // The failure names the method, so the fix is the one line it points at.
    expect(registeredMethods().filter((method) => !listed.includes(method))).toEqual([])
  })

  test('the custom org header is named, or a browser drops every tenant-scoped call', async () => {
    const headers = (await preflight('GET')).headers.get('access-control-allow-headers') ?? ''
    expect(headers.toLowerCase()).toContain(ACTIVE_ORG_HEADER.toLowerCase())
  })

  test('an origin that is not the console gets no allowance at all', async () => {
    const response = await app().request('http://localhost/internal/members', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://not-the-console.example',
        'access-control-request-method': 'GET',
      },
    })
    // A wildcard with credentials turns any page the user visits into a client of this API.
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
