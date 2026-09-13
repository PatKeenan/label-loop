import { describe, expect, test } from 'bun:test'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import endpointsFixture from './__fixtures__/endpoints.json'
import modelsFixture from './__fixtures__/models.json'
import { createCatalogue } from './catalogue.ts'

/**
 * The catalogue client, entirely offline.
 *
 * The fixtures are REAL responses, trimmed — captured from the live public catalogue on
 * 2026-09-12 rather than invented — because the whole value of this file is that it parses
 * what the provider actually sends. A hand-written fixture tests the parser against its own
 * author's assumptions, which is how a field gets read from the wrong place and nobody
 * notices until production.
 *
 * `fetch` is injected (ADR-0028), so nothing here touches a network or a bill, and the
 * failure paths — which are the interesting half — are reachable at all.
 */

const okResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

/** A `fetch` that counts, so "cached" can be asserted as "did not ask again". */
const countingFetch = (handler: (url: string) => Response | Promise<Response>) => {
  const calls: string[] = []
  const fn = (async (input: Parameters<typeof globalThis.fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push(url)
    return handler(url)
  }) as typeof globalThis.fetch
  return Object.assign(fn, { calls })
}

const catalogueFetch = () =>
  countingFetch((url) => okResponse(url.includes('/endpoints') ? endpointsFixture : modelsFixture))

describe('parsing what the provider actually sends', () => {
  test('reads id, name and per-token prices as decimal STRINGS', async () => {
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch: catalogueFetch() })
    const result = await catalogue.list()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const model = result.snapshot.models.find((m) => m.id === 'anthropic/claude-fable-5.1')
    expect(model).toBeDefined()
    // A string, not a number: this is multiplied by a token count later, and a float here
    // would throw away precision the provider bothered to publish (ADR-0027's reasoning).
    expect(typeof model?.promptUsd).toBe('string')
    expect(model?.promptUsd).toBe('0.00001')
    expect(model?.completionUsd).toBe('0.00005')
  })

  test('a price no float can hold survives BYTE FOR BYTE', async () => {
    // The fixture's own prices round-trip through a float by luck — `String(Number('0.00001'))`
    // is still `'0.00001'` — so asserting on them proved nothing, and a mutation that parsed
    // every price to a number passed the whole suite. These two do not survive the trip:
    // `'0.0000001'` becomes `'1e-7'` and the long one loses digits outright. A per-token
    // price is multiplied by a token count downstream, which is exactly where that matters.
    const fetch = countingFetch(() =>
      okResponse({
        data: [
          { id: 'a/tiny', pricing: { prompt: '0.0000001', completion: '0.000000123456789012345' } },
        ],
      }),
    )
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch })
    const result = await catalogue.list()
    if (!result.ok) throw new Error('expected a snapshot')

    expect(result.snapshot.models[0]?.promptUsd).toBe('0.0000001')
    expect(result.snapshot.models[0]?.completionUsd).toBe('0.000000123456789012345')
  })

  test('passes `reasoning.mandatory` through WITHOUT interpreting it', async () => {
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch: catalogueFetch() })
    const result = await catalogue.list()
    if (!result.ok) throw new Error('expected a snapshot')

    const model = result.snapshot.models.find((m) => m.id === 'anthropic/claude-fable-5.1')
    expect(model?.reasoningMandatory).toBe(true)
    // The measured reason this must not become "this model always reasons":
    // `gemini-3.5-flash-lite` is mandatory and reported 0 reasoning tokens at `minimal`
    // across three runs. Nothing in this type says "always reasons", by design.
    expect(Object.keys(model ?? {})).not.toContain('alwaysReasons')
  })

  test('keeps only the efforts a pin can express', async () => {
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch: catalogueFetch() })
    const result = await catalogue.list()
    if (!result.ok) throw new Error('expected a snapshot')

    const model = result.snapshot.models.find((m) => m.id === 'anthropic/claude-fable-5.1')
    // Offering an effort no pin can hold would produce a judge whose pin cannot be written.
    expect(model?.supportedEfforts).toEqual(['max', 'xhigh', 'high', 'medium', 'low'])
    expect(model?.defaultEffort).toBe('high')
  })

  test('surfaces `structured_outputs` as ADVERTISED, never as a guarantee', async () => {
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch: catalogueFetch() })
    const result = await catalogue.list()
    if (!result.ok) throw new Error('expected a snapshot')

    const haiku = result.snapshot.models.find((m) => m.id === 'anthropic/claude-haiku-4.5')
    // The flag is true here and that is CORRECT — it is advertised. What must not happen is
    // this value being used to decide offerability, because it is a union across a model's
    // endpoints: `claude-sonnet-5` advertised structured output with three of its nine
    // unable to honour it. `validate-pin` is the gate (ADR-0053).
    expect(haiku?.advertisesStructuredOutput).toBe(true)
  })

  test('a model with no id is dropped rather than half-parsed', async () => {
    const fetch = countingFetch(() => okResponse({ data: [{ name: 'nameless' }, { id: 'a/b' }] }))
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch })
    const result = await catalogue.list()
    if (!result.ok) throw new Error('expected a snapshot')

    expect(result.snapshot.models.map((m) => m.id)).toEqual(['a/b'])
  })
})

describe('the TTL cache', () => {
  test('a second call inside the TTL does not ask again', async () => {
    const fetch = catalogueFetch()
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch, ttlMs: 1000 })

    await catalogue.list()
    await catalogue.list()
    expect(fetch.calls).toHaveLength(1)
  })

  test('and after the TTL it does', async () => {
    const fetch = catalogueFetch()
    const clock = createFixedClock()
    const catalogue = createCatalogue({ clock, fetch, ttlMs: 1000 })

    await catalogue.list()
    clock.advance(1001)
    await catalogue.list()
    expect(fetch.calls).toHaveLength(2)
  })

  test('endpoint detail is cached per MODEL, not globally', async () => {
    const fetch = catalogueFetch()
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch, ttlMs: 1000 })

    await catalogue.endpointsFor('a/one')
    await catalogue.endpointsFor('a/one')
    await catalogue.endpointsFor('a/two')
    expect(fetch.calls).toHaveLength(2)
  })
})

describe('when the provider stops answering', () => {
  test('a failed refresh serves the previous snapshot, LABELLED stale, and warns', async () => {
    let fail = false
    const warnings: object[] = []
    const clock = createFixedClock()
    const catalogue = createCatalogue({
      clock,
      ttlMs: 1000,
      logger: { warn: (obj) => warnings.push(obj) },
      fetch: countingFetch(() => {
        if (fail) throw new Error('network is down')
        return okResponse(modelsFixture)
      }),
    })

    const fresh = await catalogue.list()
    if (!fresh.ok) throw new Error('expected a snapshot')
    expect(fresh.snapshot.stale).toBe(false)

    fail = true
    clock.advance(1001)
    const stale = await catalogue.list()

    // Degraded but SERVING: a stale price list beats nothing for a picker, as long as it is
    // labelled rather than presented as current (CONVENTIONS: `warn` is degraded-but-serving).
    expect(stale.ok).toBe(true)
    if (!stale.ok) return
    expect(stale.snapshot.stale).toBe(true)
    expect(stale.snapshot.models).toEqual(fresh.snapshot.models)
    expect(warnings).toHaveLength(1)
  })

  test('a cold start with no network is an explicit REASON, never an empty list', async () => {
    const catalogue = createCatalogue({
      clock: createFixedClock(),
      fetch: countingFetch(() => {
        throw new Error('network is down')
      }),
    })

    const result = await catalogue.list()
    // The distinction this whole type exists for: a wizard rendering `models.map(...)`
    // cannot tell "this provider has no models" from "we could not ask", and only one of
    // those is worth showing a person (ADR-0054).
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toContain('could not be reached')
  })

  test('a non-200 is a failure, not an empty catalogue', async () => {
    const catalogue = createCatalogue({
      clock: createFixedClock(),
      fetch: countingFetch(() => new Response('nope', { status: 503 })),
    })
    expect((await catalogue.list()).ok).toBe(false)
  })

  test('a failed refresh does not re-ask on every call', async () => {
    // Otherwise a provider outage turns each keystroke in a search box into an outbound
    // request that is already known to fail.
    let calls = 0
    const clock = createFixedClock()
    const catalogue = createCatalogue({
      clock,
      ttlMs: 1000,
      fetch: countingFetch(() => {
        calls += 1
        if (calls === 1) return okResponse(modelsFixture)
        throw new Error('network is down')
      }),
    })

    await catalogue.list()
    clock.advance(1001)
    await catalogue.list()
    await catalogue.list()
    await catalogue.list()
    expect(calls).toBe(2)
  })
})

describe('endpoint detail', () => {
  test('counts endpoints and buckets quantization, keeping `unknown` separate', async () => {
    const catalogue = createCatalogue({ clock: createFixedClock(), fetch: catalogueFetch() })
    const result = await catalogue.endpointsFor('anthropic/claude-fable-5.1')

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.endpoints.total).toBe(4)
    // Merging `unknown` into anything would hide the finding that matters: pinning a
    // precision drops every endpoint that merely did not declare one.
    expect(Object.keys(result.endpoints.byQuantization)).toContain('unknown')
    const counted = Object.values(result.endpoints.byQuantization).reduce((a, b) => a + b, 0)
    expect(counted).toBe(result.endpoints.total)
  })
})
