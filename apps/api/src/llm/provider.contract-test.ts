import { describe, expect, test } from 'bun:test'
import { judgeOutputSchema, RATIONALE_MAX_LENGTH } from '@labelloop/contracts'
import { isProviderError, type ModelProvider, type ProviderFailureKind } from './provider.port.ts'

/**
 * The shared contract every `ModelProvider` adapter must satisfy (CONVENTIONS.md: "Base
 * test suites live beside each port"). The fake passes it today; M1's real adapter
 * imports this same file rather than writing its own idea of the contract, which is the
 * only way "the fake is a peer of the real one" is a claim rather than an aspiration.
 *
 * It asserts the promises the gateway actually relies on, and nothing about *how* an
 * adapter keeps them. Notably it does not assert determinism: that is a property of the
 * fake, not of the port.
 *
 * The filename is `-test`, not `.test`, on purpose — this file defines a suite, it does
 * not run one. The runner's patterns (`*.test.ts`, `*_test.ts`, `*.spec.ts`) all miss it,
 * so it executes only where an adapter's own test calls it.
 */

/**
 * Assert that a call failed the way the port says it must. Written out rather than
 * expressed as `.rejects.toSatisfy(...)` because that matcher receives the promise, not
 * the rejection value, and quietly passes on any function it is given.
 */
export const expectProviderFailure = async (
  call: Promise<unknown>,
  kind: ProviderFailureKind,
): Promise<void> => {
  const error: unknown = await call.then(
    () => {
      throw new Error(`expected a ${kind} ProviderError, but the call resolved`)
    },
    (thrown: unknown) => thrown,
  )
  // The port says adapters throw `ProviderError` and nothing else, so this is half the
  // assertion, not a type guard for the line below it.
  expect(isProviderError(error)).toBe(true)
  expect((error as { kind?: string }).kind).toBe(kind)
}

export type ProviderContractOptions = {
  /** A fresh adapter per test: shared state between cases is how a suite lies. */
  create: () => ModelProvider
  /** A model this adapter serves. */
  model: string
  /** A model it does not serve. Every adapter must translate that into `unavailable`. */
  unknownModel: string
}

const CALL = {
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17. Repro: click it. Nothing happens.',
  context: { source: 'github' },
}

export const describeModelProviderContract = ({
  create,
  model,
  unknownModel,
}: ProviderContractOptions): void => {
  describe('the ModelProvider contract', () => {
    test('answers with structured output the published schema accepts', async () => {
      const result = await create().evaluate({ model, ...CALL })
      const parsed = judgeOutputSchema.safeParse(result.output)
      expect(parsed.success).toBe(true)
      // Capped because every character comes back into the caller's agent context
      // window, so verbosity here is a cost they pay on every request.
      expect(result.output.rationale.length).toBeLessThanOrEqual(RATIONALE_MAX_LENGTH)
    })

    test('reports token usage, because metering and cost are computed from it', async () => {
      const { usage } = await create().evaluate({ model, ...CALL })
      expect(Number.isInteger(usage.input)).toBe(true)
      expect(Number.isInteger(usage.output)).toBe(true)
      expect(usage.input).toBeGreaterThan(0)
      expect(usage.output).toBeGreaterThan(0)
    })

    test('names the model that actually answered — the graduation story, per call', async () => {
      const { servedBy } = await create().evaluate({ model, ...CALL })
      expect(typeof servedBy).toBe('string')
      expect(servedBy.length).toBeGreaterThan(0)
    })

    test('hands back the untouched payload, so a trace outlives today’s parser', async () => {
      const { raw } = await create().evaluate({ model, ...CALL })
      expect(raw).toBeDefined()
    })

    test('an aborted signal ends the call, rather than being quietly ignored', async () => {
      const provider = create()
      await expectProviderFailure(
        provider.evaluate({ model, ...CALL, signal: AbortSignal.abort() }),
        'timeout',
      )
    })

    test('a model it cannot serve is `unavailable`, not a raw error', async () => {
      await expectProviderFailure(
        create().evaluate({ model: unknownModel, ...CALL }),
        'unavailable',
      )
    })
  })
}
