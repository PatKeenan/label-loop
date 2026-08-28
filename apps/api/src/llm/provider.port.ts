import type { JudgeOutput } from '@labelloop/contracts'

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
   * The gateway's timeout, as an abort signal. An adapter that ignores it turns a
   * bounded call into an unbounded one, which is the failure the timeout exists to stop.
   */
  signal?: AbortSignal
}

/** What the call cost, in tokens. `cost.ts` turns this into money. */
export type TokenUsage = {
  input: number
  output: number
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
}

/**
 * How a provider call went wrong, in the only three shapes the rest of the system needs
 * to tell apart. The gateway maps these onto the error taxonomy and onto the published
 * `verdict.status`; nothing downstream sees a provider's own error type.
 *
 * `invalid_output` is the odd one and the important one: the call **completed**, and what
 * came back was unusable — unparseable, a refusal, off-schema. That is a rubric problem,
 * and retrying the identical request tends not to help, which is why it is separated from
 * the two failures that did not complete.
 */
export type ProviderFailureKind = 'timeout' | 'unavailable' | 'invalid_output'

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
