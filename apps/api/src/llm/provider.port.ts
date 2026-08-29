import type { JudgeOutput, ModelPin } from '@labelloop/contracts'

/**
 * Port #1 (CONVENTIONS.md "Dependency seams"): one judge call, to one model.
 *
 * **Why this port lives in `llm/` and not in `src/ports/` beside `Clock` and
 * `ErrorReporter`.** Its adapters are the only code in the repo allowed to reach a
 * provider, and that rule is machine-enforced (ADR-0016) by asserting no provider call
 * exists outside this directory. Keeping the port here means the real adapter M1 adds
 * lands inside the fence rather than outside it, so the rule stays a boundary rather than
 * an exception list.
 *
 * The port is deliberately one method. A judge is one binary question about one artifact
 * (ADR-0019), so batching, streaming and tool use have nothing to attach to — and an
 * interface that promises them would have to be honoured by every adapter that follows.
 */

/** What a provider is asked to do. Everything here comes from a versioned judge config. */
export type JudgeCall = {
  /** The model id from the `jdv_` row — `fake:deterministic`, and real ones from M1. */
  model: string
  /** The judge's binary question. Prompts live in versioned configs, not in code. */
  question: string
  /** The artifact under judgement. Their agent produced it, not ours (ADR-0019). */
  artifact: string
  /** Whatever else the judge needs to decide. Assembled by the caller; opaque to us. */
  context?: Record<string, string>
  /**
   * The routing constraints frozen onto this judge's version (ADR-0022), translated by the
   * adapter into the provider's own routing controls on every call.
   *
   * Optional because `fake:` has no endpoints to constrain — not because a real judge may
   * go unpinned. Every `llm` row carries one; the database enforces that, not this type.
   */
  pin?: ModelPin
  /**
   * The gateway's timeout, as an abort signal. An adapter that ignores it turns a
   * bounded call into an unbounded one, which is the failure the timeout exists to stop.
   */
  signal?: AbortSignal
}

/** What the call cost, in tokens. `cost.ts` turns this into money. */
export type TokenUsage = {
  input: number
  output: number
  /**
   * Billed deliberation, where the provider reported any. Absent when it did not, which is
   * not the same claim as zero.
   *
   * It is here rather than folded into `output` because it is the one part of the bill we
   * cannot see: a model with `reasoning.mandatory` deliberates privately, we pay for it,
   * and none of it can be stored or shown to an annotator (ADR-0022). Recording the count
   * is what keeps cost per verdict explicable where the content is not.
   */
  reasoning?: number
}

export type ProviderResult = {
  /** The parsed structured output — reasoning first, then the verdict (ADR-0019). */
  output: JudgeOutput
  usage: TokenUsage
  /**
   * Which model actually answered: `frontier:sonnet`, `finetune:acme-tone-v3`. Not always
   * the model that was asked for — a provider may route, and the graduation story is
   * exactly "the same judge, served by something cheaper".
   */
  servedBy: string
  /**
   * The provider's untouched response, stored beside the normalised fields
   * (CONVENTIONS.md "Data rules") so an evaluation is rerunnable and auditable rather
   * than only as good as today's parser.
   */
  raw: unknown
  /**
   * What the provider itself says this call cost, in USD. Preferred over any table we
   * keep, and absent when the provider did not say (ADR-0027) — `cost.ts` is what turns
   * that absence into an honest `priced: false` rather than a guess.
   */
  costUsd?: number
  /**
   * How many endpoints survived the pin, from the provider's routing metadata.
   *
   * **This is what keeps the port one method.** ADR-0022 requires a real call before a
   * `jdv_` freezes — to prove the pin is satisfiable at all, and to record how much
   * failover it leaves (`openai/gpt-5.6-sol` measured 1 of 5 on 2026-08-29). Carrying the
   * count on an ordinary result makes that validation an ordinary `evaluate()`, rather
   * than a second verb every adapter that ever follows would owe to one caller.
   */
  availableEndpoints?: number
}

/**
 * How a provider call went wrong, in the only four shapes the rest of the system needs
 * to tell apart. The gateway maps these onto the error taxonomy and onto the published
 * `verdict.status`; nothing downstream sees a provider's own error type.
 *
 * `invalid_output` is the odd one and the important one: the call **completed**, and what
 * came back was unusable — unparseable, a refusal, off-schema. That is a rubric problem,
 * and retrying the identical request tends not to help, which is why it is separated from
 * the two failures that did not complete.
 *
 * `misconfigured` is the fourth (ADR-0024): a failure no retry and no recovery window can
 * fix — a rejected credential, an exhausted balance, a request the provider itself calls
 * malformed. Before it existed these fell into `unavailable`, which meant three retries, a
 * circuit whose half-open probe could never succeed, and a `Retry-After` telling the
 * caller to retry something that cannot succeed. It is ours to fix, not the provider's to
 * recover from, which is why it is the only kind logged at `error`.
 */
export type ProviderFailureKind = 'timeout' | 'unavailable' | 'invalid_output' | 'misconfigured'

/** The only error type an adapter may throw. Anything else is a bug in the adapter. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  readonly kind: ProviderFailureKind
  /** The provider's own payload, when there was one. Never serialized to a caller. */
  readonly raw: unknown

  constructor(
    kind: ProviderFailureKind,
    message: string,
    options: { cause?: unknown; raw?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.kind = kind
    this.raw = options.raw
  }
}

export const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof ProviderError

export type ModelProvider = {
  /** Names the adapter in logs and span attributes. `fake`, and real ones from M1. */
  readonly name: string
  /** Run one judge. Throws `ProviderError`, and nothing else. */
  evaluate: (call: JudgeCall) => Promise<ProviderResult>
}
