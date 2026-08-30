import { describe, expect, test } from 'bun:test'
import { createFakeProvider, FAKE_MODEL } from './fake-provider.ts'
import { describeModelProviderContract, expectProviderFailure } from './provider.contract-test.ts'
import type { ModelProvider } from './provider.port.ts'
import { createProviderRegistry } from './provider-registry.ts'

/**
 * The composite is held to the same contract as the adapters inside it. That is the point
 * of the file: a dispatcher exempt from the port's rules is a place for the rules to stop
 * being true.
 */

describeModelProviderContract({
  create: () => createProviderRegistry({ providers: { fake: createFakeProvider() } }),
  model: FAKE_MODEL,
  unknownModel: 'openrouter:anthropic/claude-sonnet-5',
})

describe('dispatch', () => {
  const routed = (): { registry: ModelProvider; seen: string[] } => {
    const seen: string[] = []
    const spy = (label: string): ModelProvider => ({
      name: label,
      evaluate: (call) => {
        seen.push(`${label}:${call.model}`)
        return createFakeProvider().evaluate({ ...call, model: FAKE_MODEL })
      },
    })
    return {
      registry: createProviderRegistry({ providers: { fake: spy('fake'), openrouter: spy('or') } }),
      seen,
    }
  }

  const CALL = { question: 'Is this a bug?', artifact: 'It crashes.' }

  test('sends each model to the adapter its PREFIX names', async () => {
    const { registry, seen } = routed()
    await registry.evaluate({ model: FAKE_MODEL, ...CALL })
    await registry.evaluate({ model: 'openrouter:anthropic/claude-sonnet-5', ...CALL })

    expect(seen).toEqual(['fake:fake:deterministic', 'or:openrouter:anthropic/claude-sonnet-5'])
  })

  test('passes the model through UNSPLIT — the adapter owns its own id grammar', async () => {
    const { registry, seen } = routed()
    await registry.evaluate({ model: 'openrouter:anthropic/claude-sonnet-5', ...CALL })
    // Not `anthropic/claude-sonnet-5`: stripping the prefix here would put the grammar in
    // two places, and the adapter is the half that knows what its route accepts.
    expect(seen[0]).toContain('openrouter:anthropic/claude-sonnet-5')
  })

  test('a route with no adapter is `unavailable` — the shape of a boot without a key', async () => {
    const registry = createProviderRegistry({ providers: { fake: createFakeProvider() } })
    await expectProviderFailure(
      registry.evaluate({ model: 'openrouter:anthropic/claude-sonnet-5', ...CALL }),
      'unavailable',
    )
  })

  test('a bare model name is `unavailable`, not a thrown TypeError', async () => {
    const registry = createProviderRegistry({ providers: { fake: createFakeProvider() } })
    await expectProviderFailure(
      registry.evaluate({ model: 'claude-sonnet-5', ...CALL }),
      'unavailable',
    )
  })

  test('an empty registry serves nothing, and says so the same way', async () => {
    const registry = createProviderRegistry({ providers: {} })
    await expectProviderFailure(registry.evaluate({ model: FAKE_MODEL, ...CALL }), 'unavailable')
  })

  test('the adapter’s own failures pass through unchanged, not re-wrapped', async () => {
    const registry = createProviderRegistry({
      providers: { fake: createFakeProvider({ failFirst: 1, failWith: 'invalid_output' }) },
    })
    // `invalid_output`, not the registry's `unavailable`: a composite that flattened its
    // adapters' failure kinds would delete the distinction the gateway branches on.
    await expectProviderFailure(registry.evaluate({ model: FAKE_MODEL, ...CALL }), 'invalid_output')
  })
})
