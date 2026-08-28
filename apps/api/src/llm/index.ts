import type { ErrorCode, JudgeOutput } from '@labelloop/contracts'
import type { Clock } from '../ports/clock.ts'
import {
  type BreakerPolicy,
  type BreakerState,
  CircuitOpenError,
  createBreakerRegistry,
} from './breaker.ts'
import { type CallCost, costOf } from './cost.ts'
import {
  isProviderError,
  type JudgeCall,
  type ModelProvider,
  type ProviderFailureKind,
} from './provider.port.ts'
import { DEFAULT_RETRY_POLICY, type RetryPolicy, retry } from './retry.ts'

/**
 * **The single provider gateway.** Every model call in this codebase goes through here:
 * timeout, retry with backoff and jitter, circuit breaking, and token/cost accounting, in
 * that order, once (CONVENTIONS.md "LLM-call rules"). No `fetch` to a provider exists
 * anywhere else, and that is asserted rather than remembered (ADR-0016, and
 * `architecture.test.ts` beside this file).
 *
 * **It returns outcomes; it does not throw.** A panel fans out across judges, and one
 * judge's provider timing out is not a failure of the evaluation — the published contract
 * says so explicitly, returning the partial result with `complete: false` rather than
 * pretending or failing the whole call. Modelling that as an exception would mean every
 * caller writing the same try/catch and inventing the same mapping; returning a
 * discriminated union that is already shaped like the contract's `verdict.status` means
 * the mapping exists once, here, and the service's job stays total.
 *
 * Raw provider errors never leave this file. What crosses the boundary is a member of the
 * closed taxonomy, which is what makes the codes on a verdict branchable by an agent
 * (`PROVIDER_TIMEOUT` → retry, `CIRCUIT_OPEN` → do not).
 */

/** The subset of the request logger this module uses. Structural, so pino satisfies it. */
export type CallLogger = {
  debug: (obj: object, msg: string) => void
  info: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

type OutcomeBase = {
  /** How many times the provider was called. Surfaces flakiness a success would hide. */
  attempts: number
  /** Wall-clock for this judge, backoff included — what a caller's p99 is made of. */
  latencyMs: number
}

export type JudgeCallOutcome = OutcomeBase &
  (
    | {
        status: 'evaluated'
        output: JudgeOutput
        cost: CallCost
        servedBy: string
        raw: unknown
      }
    /** The call COMPLETED and the answer was unusable. A rubric problem; not retried. */
    | { status: 'failed'; message: string; raw: unknown }
    /** The call DID NOT COMPLETE. Infrastructure; `code` says whether retrying helps. */
    | {
        status: 'error'
        code: ErrorCode
        message: string
        retryAfterSeconds?: number
        /** For the error reporter only. Never serialized to a caller. */
        cause?: unknown
      }
  )

export type ModelGateway = {
  judge: (
    call: Omit<JudgeCall, 'signal'>,
    context?: { logger?: CallLogger },
  ) => Promise<JudgeCallOutcome>
  /** Breaker state per model, for the readiness and telemetry surfaces that want it. */
  breakerState: (model: string) => BreakerState
}

export type ModelGatewayOptions = {
  provider: ModelProvider
  clock: Clock
  retryPolicy?: RetryPolicy
  breakerPolicy?: BreakerPolicy
  /** Jitter source. Injected so a backoff schedule can be asserted rather than hoped at. */
  random?: () => number
}

/** Which failures are worth another call, and which are the same answer twice. */
const RETRYABLE: Record<ProviderFailureKind, boolean> = {
  timeout: true,
  unavailable: true,
  invalid_output: false,
}

/** Which failures say something about the DEPENDENCY rather than about the judge. */
const AFFECTS_HEALTH: Record<ProviderFailureKind, boolean> = {
  timeout: true,
  unavailable: true,
  // A badly written judge must not take a working provider out of service.
  invalid_output: false,
}

const TAXONOMY: Record<Exclude<ProviderFailureKind, 'invalid_output'>, ErrorCode> = {
  timeout: 'PROVIDER_TIMEOUT',
  unavailable: 'PROVIDER_UNAVAILABLE',
}

const kindOf = (error: unknown): ProviderFailureKind | undefined =>
  isProviderError(error) ? error.kind : undefined

export const createModelGateway = ({
  provider,
  clock,
  retryPolicy = DEFAULT_RETRY_POLICY,
  breakerPolicy,
  random,
}: ModelGatewayOptions): ModelGateway => {
  let stateLogger: CallLogger | undefined

  const breakers = createBreakerRegistry({
    clock,
    ...(breakerPolicy === undefined ? {} : { policy: breakerPolicy }),
    counts: (error) => AFFECTS_HEALTH[kindOf(error) ?? 'timeout'],
    // A state change is a lifecycle event about a dependency, and the levels mean things:
    // `warn` is degraded-but-serving, which opening is, and `info` is the lifecycle events
    // on the way back. All three are named separately because "half-open" is the one an
    // operator actually wants to see — it is the moment recovery is being tested.
    onStateChange: ({ key, from, to }) => {
      const line = { provider: provider.name, model: key, from, to }
      if (to === 'open') stateLogger?.warn(line, 'circuit opened')
      else if (to === 'half_open') stateLogger?.info(line, 'circuit half-open, probing')
      else stateLogger?.info(line, 'circuit closed')
    },
  })

  return {
    breakerState: (model) => breakers.for(model).state,

    judge: async (call, { logger } = {}) => {
      // The registry's callbacks outlive any one request, so the most recent request's
      // logger is used for state changes. Its `request_id` is honest — that request is
      // what tripped the breaker — and P6's spans are where the full causal chain lives.
      if (logger !== undefined) stateLogger = logger

      const breaker = breakers.for(call.model)
      const startedAt = clock.now()
      // Counted where the provider is actually called, not where the retry loop turns.
      // The two differ exactly when the breaker refuses an attempt, and that is the case
      // the number has to be honest about: `verdict.attempts` says how many times the
      // JUDGE was called, and a refused attempt called nobody.
      let attempts = 0

      try {
        // The breaker sits INSIDE the retry loop, not around it. Ordered the other way,
        // a request that trips the circuit would still spend its remaining attempts on a
        // dependency we have just concluded is down — and the breaker would need
        // threshold x maxAttempts provider calls to open at all. Inside, the attempt that
        // trips it short-circuits the rest of its own call.
        const { value } = await retry(
          (signal) =>
            breaker.run(() => {
              attempts += 1
              return provider.evaluate({ ...call, signal })
            }),
          {
            policy: retryPolicy,
            clock,
            ...(random === undefined ? {} : { random }),
            isRetryable: (error) =>
              // Retrying into an open circuit is the one thing the circuit exists to stop.
              !(error instanceof CircuitOpenError) && RETRYABLE[kindOf(error) ?? 'invalid_output'],
            onRetry: ({ attempt: number, delayMs, error }) => {
              logger?.warn(
                {
                  provider: provider.name,
                  model: call.model,
                  attempt: number,
                  backoff_ms: delayMs,
                  kind: kindOf(error),
                },
                'provider call failed, retrying after backoff',
              )
            },
          },
        )

        const latencyMs = clock.now() - startedAt
        const cost = costOf(call.model, value.usage)
        logger?.debug(
          {
            provider: provider.name,
            model: call.model,
            served_by: value.servedBy,
            tokens_in: cost.inputTokens,
            tokens_out: cost.outputTokens,
            cost_usd: cost.costUsd,
            latency_ms: latencyMs,
            attempts,
          },
          'provider call completed',
        )

        return {
          status: 'evaluated',
          output: value.output,
          cost,
          servedBy: value.servedBy,
          raw: value.raw,
          attempts,
          latencyMs,
        }
      } catch (error) {
        const latencyMs = clock.now() - startedAt
        const base = { attempts, latencyMs }

        if (error instanceof CircuitOpenError) {
          logger?.warn(
            { provider: provider.name, model: call.model, retry_after_ms: error.retryAfterMs },
            'provider call refused by an open circuit',
          )
          return {
            ...base,
            status: 'error',
            code: 'CIRCUIT_OPEN',
            message: 'The circuit for this model is open. Retry after the stated delay.',
            // Rounded UP: a Retry-After that expires a millisecond early sends the caller
            // straight back into a circuit that is still open.
            retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)),
          }
        }

        const kind = kindOf(error)

        if (kind === 'invalid_output') {
          logger?.warn(
            { provider: provider.name, model: call.model, attempts },
            'provider answered with unusable output',
          )
          return {
            ...base,
            status: 'failed',
            message: 'The judge did not produce a usable answer.',
            raw: isProviderError(error) ? error.raw : undefined,
          }
        }

        if (kind !== undefined) {
          logger?.warn(
            { provider: provider.name, model: call.model, kind, attempts },
            'provider call failed',
          )
          return {
            ...base,
            status: 'error',
            code: TAXONOMY[kind],
            message: 'The judge could not be reached.',
          }
        }

        // Not a `ProviderError`: the adapter broke its own contract, which is a bug in
        // our code rather than a provider's bad day. It is reported like any other
        // unexpected error, and the caller still sees a taxonomy code.
        logger?.error(
          { provider: provider.name, model: call.model, err: error },
          'provider adapter threw an unexpected error',
        )
        return {
          ...base,
          status: 'error',
          code: 'INTERNAL',
          message: 'The judge could not be run.',
          cause: error,
        }
      }
    },
  }
}

export type { BreakerState } from './breaker.ts'
export type { CallCost } from './cost.ts'
export { createFakeProvider, FAKE_MODEL, FAKE_SENTINELS } from './fake-provider.ts'
export type { JudgeCall, ModelProvider, ProviderResult, TokenUsage } from './provider.port.ts'
