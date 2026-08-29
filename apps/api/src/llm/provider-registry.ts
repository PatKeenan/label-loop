import { type ModelRoute, modelRefOf } from '@labelloop/contracts'
import {
  type JudgeCall,
  type ModelProvider,
  ProviderError,
  type ProviderResult,
} from './provider.port.ts'

/**
 * Prefix dispatch across adapters — `fake:` to the fake, `openrouter:` to the real one.
 *
 * **The composite is itself a `ModelProvider`**, which is the property worth having: it
 * satisfies the same port and passes the same contract suite as the adapters it holds,
 * rather than being a special case exempt from the rules it enforces. That is what makes
 * `finetune:` at M7 an addition to a map instead of a new branch in the gateway.
 *
 * An unregistered route throws `unavailable` rather than a `TypeError`, for the same
 * reason `modelRefOf` answers `undefined`: a `jdv_` row naming a route this build does not
 * have is data, not a bug in our code. It is also the contract suite's `unknownModel` case,
 * so the composite has to answer it the way every adapter does.
 */

export type ProviderRegistryOptions = {
  /** One adapter per route. A route with no entry is `unavailable`, not a crash. */
  providers: Partial<Record<ModelRoute, ModelProvider>>
  /** Names the composite in logs and span attributes when no route was resolved. */
  name?: string
}

export const createProviderRegistry = ({
  providers,
  name = 'registry',
}: ProviderRegistryOptions): ModelProvider => ({
  name,

  evaluate: (call: JudgeCall): Promise<ProviderResult> => {
    const ref = modelRefOf(call.model)
    if (ref === undefined) {
      return Promise.reject(
        new ProviderError('unavailable', `not a route-qualified model id: ${call.model}`),
      )
    }

    const provider = providers[ref.route]
    if (provider === undefined) {
      // The route is known to the grammar and absent from this build — the shape of a
      // production instance booted without an OpenRouter key. Saying so plainly beats a
      // crash, because the panel's other judges are fine and should still answer.
      return Promise.reject(
        new ProviderError('unavailable', `no adapter is registered for the ${ref.route} route`),
      )
    }

    return provider.evaluate(call)
  },
})
