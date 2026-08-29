import { describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, type ModelPin } from '@labelloop/contracts'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { recordingSpans } from '../testing/recording-spans.ts'
import { createModelGateway } from './index.ts'
import { createOpenRouterProvider } from './openrouter-provider.ts'
import { describeModelProviderContract, expectProviderFailure } from './provider.contract-test.ts'

/**
 * Every case here runs against an injected `fetch` (ADR-0028), so the whole failure table
 * is exercised without a network, a secret, or a bill — and nothing in this file can
 * silently skip. Live verification is `bun run verify:pin`, run deliberately by a human.
 */

const MODEL = 'openrouter:anthropic/claude-sonnet-5'

const IN_ORDER =
  '{"rationale":"Steps are present but no expected behaviour.","reasons":["missing-expected-behaviour"],"verdict":true,"confidence":0.82}'

const okBody = (content = IN_ORDER, overrides: Record<string, unknown> = {}) => ({
  model: 'anthropic/claude-sonnet-5',
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: {
    prompt_tokens: 412,
    completion_tokens: 96,
    cost: 0.0023,
    completion_tokens_details: { reasoning_tokens: 0 },
  },
  openrouter_metadata: {
    endpoints: {
      available: [
        { model: 'anthropic/claude-sonnet-5-20260630' },
        { model: 'anthropic/claude-sonnet-5-20260630' },
      ],
    },
  },
  ...overrides,
})

/** A `fetch` that answers once with a given status and body, and records what it was sent. */
const stubFetch = (status: number, body: unknown) => {
  const requests: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  const fn = ((url: string | URL | Request, init: RequestInit = {}) => {
    requests.push({
      url: String(url),
      init,
      body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>,
    })
    return Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    )
  }) as unknown as typeof globalThis.fetch
  return { fetch: fn, requests }
}

const providerWith = (status: number, body: unknown) => {
  const stub = stubFetch(status, body)
  return {
    provider: createOpenRouterProvider({ apiKey: 'test-key', fetch: stub.fetch }),
    requests: stub.requests,
  }
}

const CALL = {
  model: MODEL,
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17.',
  pin: DEFAULT_FAKE_PIN,
}

/**
 * The same suite the fake passes, IMPORTED rather than restated. That is the only thing
 * that makes "the fake is a peer of the real adapter" a claim rather than an aspiration.
 */
describeModelProviderContract({
  create: () => createOpenRouterProvider({ apiKey: 'k', fetch: stubFetch(200, okBody()).fetch }),
  model: MODEL,
  unknownModel: 'fake:deterministic',
})

describe('the request built from the pin', () => {
  test('carries require_parameters and the data-collection stance, from the pin', async () => {
    const { provider, requests } = providerWith(200, okBody())
    await provider.evaluate(CALL)

    expect(requests[0]?.body.provider).toEqual({
      require_parameters: true,
      data_collection: 'deny',
    })
  })

  test('quantizations bind only when the pin names them', async () => {
    const pinned: ModelPin = { ...DEFAULT_FAKE_PIN, quantizations: ['bf16'] }
    const { provider, requests } = providerWith(200, okBody())
    await provider.evaluate({ ...CALL, pin: pinned })

    expect(requests[0]?.body.provider).toMatchObject({ quantizations: ['bf16'] })
  })

  test('effort `none` is sent as an explicit disable, never as an omitted field', async () => {
    const { provider, requests } = providerWith(200, okBody())
    await provider.evaluate(CALL)
    // Omitting it would hand the decision to the provider's default, which is the drift a
    // frozen judge version exists to prevent — 83 of 396 models default to reasoning on.
    expect(requests[0]?.body.reasoning).toEqual({ enabled: false })
  })

  test('a stated effort is sent as that effort', async () => {
    const pinned: ModelPin = { ...DEFAULT_FAKE_PIN, reasoning: { effort: 'medium' } }
    const { provider, requests } = providerWith(200, okBody())
    await provider.evaluate({ ...CALL, pin: pinned })

    expect(requests[0]?.body.reasoning).toEqual({ effort: 'medium' })
  })

  test('sends the derived schema under strict mode, and asks for routing metadata', async () => {
    const { provider, requests } = providerWith(200, okBody())
    await provider.evaluate(CALL)

    const format = requests[0]?.body.response_format as {
      json_schema: { strict: boolean; schema: { properties: object } }
    }
    expect(format.json_schema.strict).toBe(true)
    expect(Object.keys(format.json_schema.schema.properties)).toEqual([
      'rationale',
      'reasons',
      'verdict',
      'confidence',
    ])
    const headers = requests[0]?.init.headers as Record<string, string>
    expect(headers['x-openrouter-metadata']).toBe('enabled')
  })

  test('sends the route-native id, not the route-qualified one', async () => {
    const { provider, requests } = providerWith(200, okBody())
    await provider.evaluate(CALL)
    expect(requests[0]?.body.model).toBe('anthropic/claude-sonnet-5')
  })
})

describe('a successful answer', () => {
  test('reports the DATED endpoint id, not the alias the response echoes', async () => {
    const { provider } = providerWith(200, okBody())
    const result = await provider.evaluate(CALL)
    // The alias is `anthropic/claude-sonnet-5`; the identity that answered is dated.
    expect(result.servedBy).toBe('anthropic/claude-sonnet-5-20260630')
  })

  test('falls back to the echoed model when metadata carries no endpoint', async () => {
    const { provider } = providerWith(200, okBody(IN_ORDER, { openrouter_metadata: {} }))
    const result = await provider.evaluate(CALL)
    expect(result.servedBy).toBe('anthropic/claude-sonnet-5')
  })

  test('takes cost from the provider, and counts the endpoints that survived the pin', async () => {
    const { provider } = providerWith(200, okBody())
    const result = await provider.evaluate(CALL)
    expect(result.costUsd).toBe(0.0023)
    expect(result.availableEndpoints).toBe(2)
  })

  test('reports reasoning tokens when the provider does, and omits them when it does not', async () => {
    const { provider } = providerWith(200, okBody())
    expect((await provider.evaluate(CALL)).usage.reasoning).toBe(0)

    const silent = providerWith(
      200,
      okBody(IN_ORDER, { usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    )
    // Absent, not zero: a provider that said nothing has not said "none".
    expect((await silent.provider.evaluate(CALL)).usage.reasoning).toBeUndefined()
  })
})

describe('an answer that completed and is unusable', () => {
  test('a verdict emitted FIRST is invalid_output — though Zod accepts the object', async () => {
    const verdictFirst = '{"verdict":true,"rationale":"a","reasons":[],"confidence":0.9}'
    const { provider } = providerWith(200, okBody(verdictFirst))
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })

  test('off-schema content is invalid_output', async () => {
    const { provider } = providerWith(
      200,
      okBody('{"rationale":"a","reasons":[],"verdict":"yes","confidence":2}'),
    )
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })

  test('content that is not JSON at all is invalid_output', async () => {
    const { provider } = providerWith(200, okBody('I cannot answer that.'))
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })

  test('a 200 with finish_reason `error` is invalid_output — it completed, unusably', async () => {
    const body = okBody()
    body.choices = [{ finish_reason: 'error', message: { content: '' } }]
    const { provider } = providerWith(200, body)
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })

  test('a 200 with no message at all is invalid_output', async () => {
    const { provider } = providerWith(200, { model: 'x', choices: [] })
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })
})

describe('the failure table, row by row', () => {
  const moderation = { error: { code: 400, metadata: { reasons: ['harassment'] } } }

  test('401 and 402 are misconfigured — a rejected key is rejected twice', async () => {
    for (const status of [401, 402]) {
      const { provider } = providerWith(status, { error: { code: status, message: 'no' } })
      await expectProviderFailure(provider.evaluate(CALL), 'misconfigured')
    }
  })

  test('a 400 WITHOUT moderation metadata is misconfigured — our bug, not their bad day', async () => {
    const { provider } = providerWith(400, { error: { code: 400, message: 'bad request' } })
    await expectProviderFailure(provider.evaluate(CALL), 'misconfigured')
  })

  test('a 400 WITH moderation metadata is invalid_output — a refusal COMPLETED', async () => {
    const { provider } = providerWith(400, moderation)
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })

  test('a 403 guardrail block is invalid_output for the same reason', async () => {
    const { provider } = providerWith(403, { error: { code: 403, metadata: { reasons: ['x'] } } })
    await expectProviderFailure(provider.evaluate(CALL), 'invalid_output')
  })

  test('408 is a timeout', async () => {
    const { provider } = providerWith(408, { error: { code: 408 } })
    await expectProviderFailure(provider.evaluate(CALL), 'timeout')
  })

  test('429, 502, 503 and 500 are unavailable — retryable, and they count against health', async () => {
    for (const status of [429, 500, 502, 503]) {
      const { provider } = providerWith(status, { error: { code: status } })
      await expectProviderFailure(provider.evaluate(CALL), 'unavailable')
    }
  })

  test('a 503 naming an empty routing pool is unavailable, not a special case', async () => {
    // Call time cannot tell a transient empty pool from a permanently unsatisfiable pin.
    // Creation-time validation is the mitigation; this is the cost of not having one here.
    const { provider } = providerWith(503, {
      error: { code: 503, message: 'No endpoints found that match your routing preferences' },
    })
    await expectProviderFailure(provider.evaluate(CALL), 'unavailable')
  })

  test('an unknown slug (404) is unavailable', async () => {
    const { provider } = providerWith(404, { error: { code: 404, message: 'not found' } })
    await expectProviderFailure(provider.evaluate(CALL), 'unavailable')
  })

  test('a non-JSON error body does not mask the status that explains it', async () => {
    const { provider } = providerWith(502, '<html>Bad Gateway</html>')
    await expectProviderFailure(provider.evaluate(CALL), 'unavailable')
  })

  test('a dead socket is unavailable, and an abort mid-flight is a timeout', async () => {
    const dead = createOpenRouterProvider({
      apiKey: 'k',
      fetch: (() =>
        Promise.reject(new TypeError('fetch failed'))) as unknown as typeof globalThis.fetch,
    })
    await expectProviderFailure(dead.evaluate(CALL), 'unavailable')

    const aborted = createOpenRouterProvider({
      apiKey: 'k',
      fetch: (() => {
        const error = new Error('aborted')
        error.name = 'AbortError'
        return Promise.reject(error)
      }) as unknown as typeof globalThis.fetch,
    })
    await expectProviderFailure(aborted.evaluate(CALL), 'timeout')
  })
})

describe('a moderation payload, all the way through the gateway', () => {
  test('never reaches a log line or a span — it carries the customer’s artifact', async () => {
    const artifact = 'Login button does nothing on Safari 17.'
    const spans = recordingSpans()
    const lines: Array<Record<string, unknown>> = []
    const at = () => (fields: object, msg: string) => lines.push({ ...fields, msg })
    const logger = { debug: at(), info: at(), warn: at(), error: at() }

    const { provider } = providerWith(400, {
      error: { code: 400, metadata: { reasons: ['harassment'], flagged_input: artifact } },
    })
    const gateway = createModelGateway({
      provider,
      clock: createFixedClock(),
      tracer: spans.tracer,
    })
    const outcome = await gateway.judge({ ...CALL, artifact }, { logger, slug: 'is-bug' })

    // A refusal COMPLETED, so it is a rubric problem the console shows — not an incident.
    expect(outcome.status).toBe('failed')

    const logged = JSON.stringify(lines)
    const traced = JSON.stringify(spans.spans().map((span) => span.attributes))
    for (const serialized of [logged, traced]) {
      expect(serialized).not.toContain('Safari')
      expect(serialized).not.toContain('flagged_input')
      expect(serialized).not.toContain('harassment')
    }
    // And it IS kept where it belongs: the raw payload rides the outcome into the
    // access-controlled traces table, which is what makes an evaluation rerunnable.
    if (outcome.status !== 'failed') throw new Error('unreachable')
    expect(JSON.stringify(outcome.raw)).toContain('flagged_input')
  })
})
