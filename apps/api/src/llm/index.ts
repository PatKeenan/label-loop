import type { ErrorCode, JudgeOutput } from '@labelloop/contracts'
import { context, SpanKind, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api'
import type { Clock } from '../ports/clock.ts'
import {
  ATTR_ATTEMPTS,
  ATTR_BACKOFF_MS,
  ATTR_COST_PRICED,
  ATTR_COST_USD,
  ATTR_ERROR_CODE,
  ATTR_FAILURE_KIND,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_JUDGE_SLUG,
  ATTR_JUDGE_VERSION_ID,
  ATTR_OUTCOME,
  ATTR_REASONING_TOKENS,
} from './attributes.ts'
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
 *
 * **It is also the only place model calls are traced** (ADR-0007). Two levels of span, and
 * the split is the point: one per `judge()` call, which is the unit that has a cost and a
 * verdict, and one per actual provider ATTEMPT beneath it. A single flat span would show a
 * judge that took four seconds; the nesting shows three attempts, two backoff gaps and a
 * breaker refusal, which is the difference between knowing something was slow and knowing
 * why. Attempts refused by an open circuit produce no child span at all, because nobody
 * was called.
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

/**
 * What the CALLER knows about this judge that the provider does not need but the telemetry
 * does: which judge it is, and which immutable version asked the question. Without them a
 * slow trace says "some model call was slow"; with them it says which judge, at which
 * version — and a version is the thing you can roll back.
 */
export type JudgeCallContext = {
  logger?: CallLogger
  slug?: string
  judgeVersionId?: string
}

export type ModelGateway = {
  judge: (call: Omit<JudgeCall, 'signal'>, context?: JudgeCallContext) => Promise<JudgeCallOutcome>
  /** Breaker state per model, for the readiness and telemetry surfaces that want it. */
  breakerState: (model: string) => BreakerState
}

export type ModelGatewayOptions = {
  provider: ModelProvider
  clock: Clock
  /**
   * Where the model-call spans come from. Injected like everything else here rather than
   * read from OTel's global, so a test can assert on the spans a real provider failure
   * produces without registering a process-wide tracer provider it then has to live with.
   */
  tracer: Tracer
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
  // A rejected key is still rejected on the second call. Retrying is the same answer
  // twice, paid for three times (ADR-0024).
  misconfigured: false,
}

/** Which failures say something about the DEPENDENCY rather than about the judge. */
const AFFECTS_HEALTH: Record<ProviderFailureKind, boolean> = {
  timeout: true,
  unavailable: true,
  // A badly written judge must not take a working provider out of service.
  invalid_output: false,
  // Nothing for a half-open probe to recover. A breaker over this condition would cycle
  // forever without ever being the thing that fixes it.
  misconfigured: false,
}

/**
 * Kinds with no branch of their own, and the code each becomes. `invalid_output` is
 * excluded because it is not an error at all — the call completed. `misconfigured` is
 * excluded because it needs `cause` set and a louder log level, which is a branch.
 */
const TAXONOMY: Record<
  Exclude<ProviderFailureKind, 'invalid_output' | 'misconfigured'>,
  ErrorCode
> = {
  timeout: 'PROVIDER_TIMEOUT',
  unavailable: 'PROVIDER_UNAVAILABLE',
}

const kindOf = (error: unknown): ProviderFailureKind | undefined =>
  isProviderError(error) ? error.kind : undefined

export const createModelGateway = ({
  provider,
  clock,
  tracer,
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

    judge: async (call, { logger, slug, judgeVersionId } = {}) => {
      // The registry's callbacks outlive any one request, so the most recent request's
      // logger is used for state changes. Its `request_id` is honest — that request is
      // what tripped the breaker — and the spans below are where the full causal chain
      // lives, because a span belongs to the call that produced it and a logger does not.
      if (logger !== undefined) stateLogger = logger

      // Named for the judge rather than the model, because "which judge is slow" is the
      // question, and several judges share one model. The model is an attribute.
      const span = tracer.startSpan(`judge ${slug ?? call.model}`, {
        kind: SpanKind.INTERNAL,
        attributes: {
          [ATTR_GEN_AI_SYSTEM]: provider.name,
          [ATTR_GEN_AI_REQUEST_MODEL]: call.model,
          ...(slug === undefined ? {} : { [ATTR_JUDGE_SLUG]: slug }),
          ...(judgeVersionId === undefined ? {} : { [ATTR_JUDGE_VERSION_ID]: judgeVersionId }),
        },
      })
      // Note what is NOT here: the question, the artifact, or the context. Those are the
      // customer's content, and CONVENTIONS' "log metadata, not content" is a rule about
      // telemetry rather than about pino — a span is read by more people than a log line.
      //
      // Attempt spans are parented EXPLICITLY through this context rather than through the
      // ambient one, so the shape of a trace does not depend on a context manager being
      // installed — which it is in production and is not in a unit test.
      const parentContext = trace.setSpan(context.active(), span)

      /**
       * Every exit from this function goes through here: annotate the span with the
       * outcome, end it, answer. One funnel rather than five, because there are five ways
       * out and the one that gets forgotten is always the one you needed.
       */
      const finish = (outcome: JudgeCallOutcome): JudgeCallOutcome => {
        span.setAttributes({
          [ATTR_OUTCOME]: outcome.status,
          [ATTR_ATTEMPTS]: outcome.attempts,
        })
        if (outcome.status === 'evaluated') {
          span.setAttributes({
            [ATTR_GEN_AI_RESPONSE_MODEL]: outcome.servedBy,
            [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: outcome.cost.inputTokens,
            [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: outcome.cost.outputTokens,
            [ATTR_COST_USD]: outcome.cost.costUsd,
            // Zero is ambiguous without this: M0's fake model is genuinely free, and a
            // model with no price on file also reports zero.
            [ATTR_COST_PRICED]: outcome.cost.priced,
            // Only when the provider reported it. Absent is not zero, and a span that
            // asserted zero would make invisible deliberation look measured.
            ...(outcome.cost.reasoningTokens === undefined
              ? {}
              : { [ATTR_REASONING_TOKENS]: outcome.cost.reasoningTokens }),
          })
        } else if (outcome.status === 'error') {
          span.setAttribute(ATTR_ERROR_CODE, outcome.code)
          // Only `error` sets the span's status. A `failed` outcome means the call WORKED
          // and the judge's answer was unusable — a rubric problem to fix in a prompt, not
          // an incident. Colouring it red in Tempo would train everyone to ignore red.
          span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.message })
        }
        span.end()
        return outcome
      }

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
            breaker.run(async () => {
              attempts += 1
              // One span per ATTEMPT, and only for attempts that reach the provider: an
              // attempt the breaker refuses never gets here, which is why a trace showing
              // one child span and three `attempts` is not a contradiction.
              const attemptSpan = tracer.startSpan(
                `provider call ${call.model}`,
                {
                  kind: SpanKind.CLIENT,
                  attributes: {
                    [ATTR_GEN_AI_SYSTEM]: provider.name,
                    [ATTR_GEN_AI_REQUEST_MODEL]: call.model,
                    [ATTR_ATTEMPTS]: attempts,
                  },
                },
                parentContext,
              )
              try {
                const result = await provider.evaluate({ ...call, signal })
                attemptSpan.setAttributes({
                  [ATTR_GEN_AI_RESPONSE_MODEL]: result.servedBy,
                  [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: result.usage.input,
                  [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: result.usage.output,
                })
                return result
              } catch (error) {
                const kind = kindOf(error)
                if (kind !== undefined) attemptSpan.setAttribute(ATTR_FAILURE_KIND, kind)
                attemptSpan.setStatus({ code: SpanStatusCode.ERROR })
                throw error
              } finally {
                attemptSpan.end()
              }
            }),
          {
            policy: retryPolicy,
            clock,
            ...(random === undefined ? {} : { random }),
            isRetryable: (error) =>
              // Retrying into an open circuit is the one thing the circuit exists to stop.
              !(error instanceof CircuitOpenError) && RETRYABLE[kindOf(error) ?? 'invalid_output'],
            onRetry: ({ attempt: number, delayMs, error }) => {
              // An event rather than another span: the backoff is a gap between attempts,
              // and marking the gap is what makes the shape readable at a glance.
              span.addEvent('backoff', {
                [ATTR_ATTEMPTS]: number,
                [ATTR_BACKOFF_MS]: delayMs,
                ...(kindOf(error) === undefined ? {} : { [ATTR_FAILURE_KIND]: kindOf(error) }),
              })
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
        // The provider's own figure when it gave one (ADR-0027); the table otherwise.
        const cost = costOf(call.model, value.usage, value.costUsd)
        logger?.debug(
          {
            provider: provider.name,
            model: call.model,
            served_by: value.servedBy,
            tokens_in: cost.inputTokens,
            tokens_out: cost.outputTokens,
            reasoning_tokens: cost.reasoningTokens ?? null,
            cost_usd: cost.costUsd,
            latency_ms: latencyMs,
            attempts,
          },
          'provider call completed',
        )

        return finish({
          status: 'evaluated',
          output: value.output,
          cost,
          servedBy: value.servedBy,
          raw: value.raw,
          attempts,
          latencyMs,
        })
      } catch (error) {
        const latencyMs = clock.now() - startedAt
        const base = { attempts, latencyMs }

        if (error instanceof CircuitOpenError) {
          logger?.warn(
            { provider: provider.name, model: call.model, retry_after_ms: error.retryAfterMs },
            'provider call refused by an open circuit',
          )
          span.setAttribute(ATTR_FAILURE_KIND, 'circuit_open')
          return finish({
            ...base,
            status: 'error',
            code: 'CIRCUIT_OPEN',
            message: 'The circuit for this model is open. Retry after the stated delay.',
            // Rounded UP: a Retry-After that expires a millisecond early sends the caller
            // straight back into a circuit that is still open.
            retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)),
          })
        }

        const kind = kindOf(error)

        if (kind === 'invalid_output') {
          logger?.warn(
            { provider: provider.name, model: call.model, attempts },
            'provider answered with unusable output',
          )
          return finish({
            ...base,
            status: 'failed',
            message: 'The judge did not produce a usable answer.',
            raw: isProviderError(error) ? error.raw : undefined,
          })
        }

        // Before the generic branch, because it is the one kind that is OUR fault. The
        // levels mean things (CONVENTIONS.md "Logging"): `error` is alert-worthy, and this
        // never self-heals and takes every judge down at once, which makes it the
        // strongest candidate for M3's one alert rule. It sets `cause` for the same
        // reason — `evaluate.ts` forwards that to the error reporter, and a condition
        // nobody is told about is a condition nobody fixes.
        //
        // Deliberately NOT surfaced on `/readyz` (ADR-0024): the console and the trace
        // explorer are fine, and marking the instance unready would produce a restart loop
        // over a condition no restart fixes.
        if (kind === 'misconfigured') {
          // NO `err` here, deliberately. `ProviderError.raw` is an own-enumerable field
          // holding the provider's payload, and a JSON logger serializes it — so `err`
          // would put a 400's echoed request, or a moderation refusal's `flagged_input`,
          // into log storage. That is the customer's content, and CONVENTIONS is explicit:
          // log metadata, not content; payloads live in the access-controlled traces table.
          // Nothing is lost — `cause` below carries the whole error to the error reporter,
          // which is the sink that is allowed to hold detail (ADR-0007).
          logger?.error(
            { provider: provider.name, model: call.model, kind, attempts },
            'provider rejected the request in a way no retry can fix',
          )
          return finish({
            ...base,
            status: 'error',
            // The existing code, so no published contract changes: from the caller's side
            // this is our problem, not something for them to retry or route around.
            code: 'INTERNAL',
            message: 'The judge could not be run.',
            cause: error,
          })
        }

        if (kind !== undefined) {
          logger?.warn(
            { provider: provider.name, model: call.model, kind, attempts },
            'provider call failed',
          )
          return finish({
            ...base,
            status: 'error',
            code: TAXONOMY[kind],
            message: 'The judge could not be reached.',
          })
        }

        // Not a `ProviderError`: the adapter broke its own contract, which is a bug in
        // our code rather than a provider's bad day. It is reported like any other
        // unexpected error, and the caller still sees a taxonomy code.
        logger?.error(
          { provider: provider.name, model: call.model, err: error },
          'provider adapter threw an unexpected error',
        )
        return finish({
          ...base,
          status: 'error',
          code: 'INTERNAL',
          message: 'The judge could not be run.',
          cause: error,
        })
      }
    },
  }
}

export type { BreakerState } from './breaker.ts'
export type { CallCost } from './cost.ts'
export { createFakeProvider, FAKE_MODEL, FAKE_SENTINELS } from './fake-provider.ts'
export type { JudgeCall, ModelProvider, ProviderResult, TokenUsage } from './provider.port.ts'
