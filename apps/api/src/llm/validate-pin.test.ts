import { describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, type ModelPin } from '@labelloop/contracts'
import { createFakeProvider, FAKE_MODEL } from './fake-provider.ts'
import { createOpenRouterProvider } from './openrouter-provider.ts'
import { type ModelProvider, ProviderError } from './provider.port.ts'
import { createProviderRegistry } from './provider-registry.ts'
import { validatePin } from './validate-pin.ts'

/**
 * Validation is what stands between "a pin that routes nowhere" and "a permanently broken
 * judge", because ADR-0003 freezes the row immediately after. So the two properties worth
 * asserting are that it answers rather than throws, and that it costs nothing on a route
 * with nothing to ask.
 */

const NOW = () => new Date('2026-08-30T12:00:00.000Z')

const validateWith = (provider: ModelProvider, model: string, pin: ModelPin = DEFAULT_FAKE_PIN) =>
  validatePin({ provider, model, pin, now: NOW })

/** Counts HTTP calls, so "makes no network call" can be a measurement, not a claim. */
const countingFetch = (status: number, body: unknown) => {
  let calls = 0
  const fn = (() => {
    calls += 1
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as unknown as typeof globalThis.fetch
  return { fetch: fn, calls: () => calls }
}

const OK_BODY = {
  id: 'gen-1',
  object: 'chat.completion',
  created: 1,
  model: 'anthropic/claude-sonnet-5',
  system_fingerprint: null,
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content:
          '{"rationale":"No expected behaviour is stated.","reasons":[],"verdict":true,"confidence":0.9}',
      },
    },
  ],
  usage: { prompt_tokens: 60, completion_tokens: 30, total_tokens: 90, cost: 0.0004 },
  openrouter_metadata: {
    attempt: 1,
    is_byok: false,
    region: null,
    requested: 'anthropic/claude-sonnet-5',
    strategy: 'default',
    summary: 'routed',
    endpoints: {
      total: 9,
      available: [
        {
          model: 'anthropic/claude-sonnet-5-20260630',
          provider: 'Amazon Bedrock',
          selected: false,
        },
        { model: 'anthropic/claude-sonnet-5-20260630', provider: 'Anthropic', selected: true },
      ],
    },
  },
}

describe('a `fake:` route', () => {
  test('short-circuits to ok and makes NO http call — zero-secret boot depends on it', async () => {
    const stub = countingFetch(200, OK_BODY)
    const registry = createProviderRegistry({
      providers: {
        fake: createFakeProvider(),
        openrouter: createOpenRouterProvider({ apiKey: 'k', fetch: stub.fetch }),
      },
    })

    const result = await validateWith(registry, FAKE_MODEL)
    expect(result.ok).toBe(true)
    // The seed validates every judge, and a fresh clone has no key. If this ever calls out,
    // `bun run db:setup` stops being free and offline.
    expect(stub.calls()).toBe(0)
  })

  test('records zero endpoints rather than inventing one', async () => {
    const result = await validateWith(createFakeProvider(), FAKE_MODEL)
    if (!result.ok) throw new Error('unreachable')
    // A route with no endpoints has no failover to report, and a fabricated 1 would put a
    // fake measurement in the column that exists to hold real ones.
    expect(result.validation.available_endpoints).toBe(0)
    expect(result.validation.served_by).toBe(FAKE_MODEL)
    expect(result.validation.validated_at).toBe('2026-08-30T12:00:00.000Z')
  })
})

describe('a satisfiable pin', () => {
  test('reports the endpoint count and the DATED id that answered', async () => {
    const stub = countingFetch(200, OK_BODY)
    const provider = createOpenRouterProvider({ apiKey: 'k', fetch: stub.fetch })

    const result = await validateWith(provider, 'openrouter:anthropic/claude-sonnet-5')
    if (!result.ok) throw new Error('unreachable')
    expect(result.validation.available_endpoints).toBe(2)
    expect(result.validation.served_by).toBe('anthropic/claude-sonnet-5-20260630')
    // Exactly one call. Validation is a cost paid per judge creation, not per attempt.
    expect(stub.calls()).toBe(1)
  })

  test('sends the pin it is validating, not a default', async () => {
    const sent: Array<Record<string, unknown>> = []
    const fn = ((_url: string, init: RequestInit = {}) => {
      sent.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>)
      return Promise.resolve(new Response(JSON.stringify(OK_BODY), { status: 200 }))
    }) as unknown as typeof globalThis.fetch

    const pin: ModelPin = {
      capabilities: ['structured_outputs'],
      data_collection: 'deny',
      quantizations: ['bf16'],
      reasoning: { effort: 'medium' },
    }
    await validateWith(
      createOpenRouterProvider({ apiKey: 'k', fetch: fn }),
      'openrouter:anthropic/claude-sonnet-5',
      pin,
    )

    // Validating anything other than the pin about to be frozen would prove nothing.
    expect(sent[0]?.provider).toMatchObject({
      require_parameters: true,
      data_collection: 'deny',
      quantizations: ['bf16'],
    })
    expect(sent[0]?.reasoning).toEqual({ effort: 'medium' })
  })
})

describe('a pin that cannot be satisfied', () => {
  const failing = (kind: 'unavailable' | 'invalid_output' | 'timeout' | 'misconfigured') =>
    ({
      name: 'unhappy',
      evaluate: () => Promise.reject(new ProviderError(kind, 'raw provider prose')),
    }) satisfies ModelProvider

  test('comes back as a named reason, and does NOT throw', async () => {
    // The whole point: M4's wizard renders this beside a form field. An exception would
    // make "this judge cannot exist" something a caller discovers by catching.
    const result = await validateWith(failing('unavailable'), 'openrouter:some/model')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('unavailable')
    expect(result.reason).toContain('no endpoint could serve this pin')
    // ADR-0023's revisit trigger is exactly this case, so the reason names the constraints.
    expect(result.reason).toContain('data-collection')
  })

  test('every failure kind has its own reason, in the caller’s vocabulary', async () => {
    const reasons = await Promise.all(
      (['unavailable', 'invalid_output', 'timeout', 'misconfigured'] as const).map(async (kind) => {
        const result = await validateWith(failing(kind), 'openrouter:some/model')
        return result.ok ? '' : result.reason
      }),
    )
    // Distinct, non-empty, and none of them leaking the provider's own prose.
    expect(new Set(reasons).size).toBe(4)
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(0)
      expect(reason).not.toContain('raw provider prose')
    }
  })

  test('a model that answers OUT OF ORDER fails validation — the live Haiku case', async () => {
    // Measured 2026-08-30: `claude-haiku-4.5` advertises structured_outputs, is sent
    // maxLength 280 under strict mode, and overran it 4 times out of 4. Catalogue
    // metadata cannot gate this; only a real call can.
    const overlong = JSON.stringify({
      rationale: 'x'.repeat(600),
      reasons: [],
      verdict: true,
      confidence: 0.9,
    })
    const body = {
      ...OK_BODY,
      choices: [
        { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: overlong } },
      ],
    }
    const provider = createOpenRouterProvider({
      apiKey: 'k',
      fetch: countingFetch(200, body).fetch,
    })

    const result = await validateWith(provider, 'openrouter:anthropic/claude-haiku-4.5')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.kind).toBe('invalid_output')
    expect(result.reason).toContain('judge schema')
  })

  test('an adapter that breaks its own contract still answers rather than throwing', async () => {
    const broken: ModelProvider = {
      name: 'broken',
      evaluate: () => Promise.reject(new TypeError('undefined is not a function')),
    }
    const result = await validateWith(broken, 'openrouter:some/model')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).not.toContain('undefined is not a function')
  })

  test('a model id with no route prefix is rejected before anything is called', async () => {
    const stub = countingFetch(200, OK_BODY)
    const provider = createOpenRouterProvider({ apiKey: 'k', fetch: stub.fetch })
    const result = await validateWith(provider, 'claude-sonnet-5')

    expect(result.ok).toBe(false)
    expect(stub.calls()).toBe(0)
  })
})
