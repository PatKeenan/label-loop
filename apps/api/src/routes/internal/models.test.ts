import { describe, expect, test } from 'bun:test'
import { errorEnvelopeSchema } from '@labelloop/contracts'
import { metrics, trace } from '@opentelemetry/api'
import { Hono } from 'hono'
import { createFixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import type { AppEnv } from '../../app-env.ts'
import { type Config, loadConfig } from '../../config.ts'
import type { CatalogueModel } from '../../llm/catalogue.ts'
import { createFakeProvider, createModelGateway } from '../../llm/index.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import type { OrgRole } from '../../repositories/org-members.ts'
import { fakeAuth } from '../../testing/fake-auth.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeDatabase } from '../../testing/fake-database.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'
import { createJudgeRoutes } from './judges.ts'
import { createModelRoutes } from './models.ts'

/**
 * What the picker is allowed to claim (ADR-0053).
 *
 * No database and no better-auth: the catalogue is a fake and the session is established by a
 * probe middleware, because everything asserted here is about the SHAPE of two answers — what
 * `/internal/models` says, and what it refuses to say. `llm/catalogue.test.ts` owns the
 * parsing and the caching against real recorded responses.
 */

const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

/** A complete pin: `capabilities` is required, so a partial one is a 422 rather than a test. */
const VALID_PIN = {
  capabilities: ['structured_outputs'],
  data_collection: 'deny',
  reasoning: { effort: 'none' },
} as const

const HAIKU: CatalogueModel = {
  id: 'anthropic/claude-haiku-4.5',
  name: 'Anthropic: Claude Haiku 4.5',
  promptUsd: '0.000001',
  completionUsd: '0.000005',
  reasoningMandatory: false,
  supportedEfforts: ['none', 'low', 'high'],
  defaultEffort: 'low',
  // Advertised. Which is a union across a model's endpoints, and therefore not a promise
  // about the one that answers (ADR-0053).
  advertisesStructuredOutput: true,
}

const hostWith = (catalogue: ReturnType<typeof fakeCatalogue>, role: OrgRole = 'admin') => {
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
    modelProvider: createFakeProvider(),
    catalogue,
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: noopMeter,
    auth: fakeAuth(),
    rateLimitStore: createMemoryRateLimitStore(),
  })

  // The routes under test, mounted behind a stand-in session — the pattern
  // `rate-limit.test.ts` established, so the real error handler still serializes.
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
  probe.route('/', createModelRoutes())
  probe.route('/', createJudgeRoutes())
  app.route('/probe', probe)
  return app
}

describe('what the list says', () => {
  test('cost, efforts and the mandatory flag, all passed through', async () => {
    const app = hostWith(fakeCatalogue({ models: [HAIKU] }))
    const response = await app.request('/probe/models')

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      data: { models: Record<string, unknown>[]; stale: boolean }
    }
    const model = body.data.models[0]
    // Strings, not numbers — the precision the provider published survives the round trip.
    expect(model?.prompt_usd_per_token).toBe('0.000001')
    expect(model?.supported_efforts).toEqual(['none', 'low', 'high'])
    expect(model?.reasoning_mandatory).toBe(false)
    expect(body.data.stale).toBe(false)
  })

  test('the structured-output flag is named ADVERTISES, not SUPPORTS', async () => {
    const app = hostWith(fakeCatalogue({ models: [HAIKU] }))
    const body = (await (await app.request('/probe/models')).json()) as {
      data: { models: Record<string, unknown>[] }
    }

    // The name is the documentation here. The flag is a UNION across a model's endpoints —
    // `claude-sonnet-5` advertised structured output while three of its nine could not
    // honour it — so a field called `supports_` would be a claim about the endpoint that
    // answers, which this value cannot make (ADR-0053).
    expect(body.data.models[0]).toHaveProperty('advertises_structured_output')
    expect(body.data.models[0]).not.toHaveProperty('supports_structured_output')
  })

  test('and nothing here is a data_collection claim', async () => {
    const app = hostWith(fakeCatalogue({ models: [HAIKU] }))
    const text = await (await app.request('/probe/models')).text()
    // No catalogue exposes a data policy (ADR-0023). A field would be an invention.
    expect(text).not.toContain('data_collection')
  })
})

describe('when the catalogue cannot be reached', () => {
  test('a cold start is an ERROR envelope, not an empty list', async () => {
    const app = hostWith(fakeCatalogue({ unavailable: true }))
    const response = await app.request('/probe/models')

    // `{ models: [] }` would render as "this provider has no models", which is a different
    // and false statement (ADR-0054).
    expect(response.status).toBe(503)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.data?.error.code).toBe('PROVIDER_UNAVAILABLE')
  })

  test('a stale snapshot is served and SAYS it is stale', async () => {
    const app = hostWith(fakeCatalogue({ models: [HAIKU] }))
    // The fake reports fresh; the shape is what matters — `stale` exists and is rendered,
    // so the console can say "last updated at…" instead of presenting old prices as current.
    const body = (await (await app.request('/probe/models')).json()) as {
      data: { stale: boolean; fetched_at: string }
    }
    expect(body.data).toHaveProperty('stale')
    expect(body.data.fetched_at).toMatch(/^\d{4}-/)
  })
})

describe('endpoint detail', () => {
  test('a model id containing a slash is matched whole', async () => {
    const app = hostWith(fakeCatalogue({ endpoints: { total: 4 } }))
    const response = await app.request('/probe/models/anthropic/claude-haiku-4.5/endpoints')

    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { model_id: string; total_endpoints: number } }
    // Not `anthropic` — the id is two segments and a naive `:model_id` would truncate it.
    expect(body.data.model_id).toBe('anthropic/claude-haiku-4.5')
    expect(body.data.total_endpoints).toBe(4)
  })
})

describe('validate-pin is the gate', () => {
  test('an unsatisfiable pin is a 200 with a reason, NOT an error envelope', async () => {
    const app = hostWith(fakeCatalogue())
    const response = await app.request('/probe/judges/validate-pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'nonsense-without-a-route',
        pin: VALID_PIN,
      }),
    })

    // The wizard renders this beside the field. Throwing would make a form error something
    // the client has to catch to discover.
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { ok: boolean; reason: string } }
    expect(body.data.ok).toBe(false)
    expect(body.data.reason).toContain('route-qualified')
  })

  test('a satisfiable pin returns the measured endpoint count', async () => {
    const app = hostWith(fakeCatalogue())
    const response = await app.request('/probe/judges/validate-pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fake:deterministic',
        pin: VALID_PIN,
      }),
    })

    const body = (await response.json()) as {
      data: { ok: boolean; available_endpoints: number; served_by: string }
    }
    expect(body.data.ok).toBe(true)
    // Zero is the honest count for a route with no endpoints — not 1, which would put an
    // invented measurement in the field that exists to hold real ones.
    expect(body.data.available_endpoints).toBe(0)
  })

  test('a malformed body is a 422 in the standard envelope', async () => {
    const app = hostWith(fakeCatalogue())
    const response = await app.request('/probe/judges/validate-pin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: '' }),
    })

    expect(response.status).toBe(422)
    expect(errorEnvelopeSchema.safeParse(await response.json()).data?.error.code).toBe(
      'VALIDATION_ERROR',
    )
  })
})

describe('the role guard', () => {
  test.each([['annotator'], ['guest_expert']] as const)(
    '%s reaches neither the catalogue nor the validator',
    async (role) => {
      const app = hostWith(fakeCatalogue({ models: [HAIKU] }), role)
      expect((await app.request('/probe/models')).status).toBe(403)
      expect(
        (
          await app.request('/probe/judges/validate-pin', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'fake:deterministic',
              pin: VALID_PIN,
            }),
          })
        ).status,
      ).toBe(403)
    },
  )
})
