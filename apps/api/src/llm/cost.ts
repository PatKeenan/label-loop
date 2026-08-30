import type { TokenUsage } from './provider.port.ts'

/**
 * Token and cost accounting, computed here because `llm/` is the one place every provider
 * call passes through (CONVENTIONS.md "LLM-call rules"). Emitted as span attributes at P6
 * and, from M2, as the input to metering.
 *
 * This is the number the whole product argument rests on: "your judging costs 10x less
 * and still agrees with Sarah" (ADR-0019) is a claim about cost per verdict, and a claim
 * measured only at the end of a billing cycle cannot be attributed to a judge, a panel or
 * a model. So it is computed per call, beside the tokens it came from.
 */

/** Dollars per million tokens — the unit every provider publishes its prices in. */
export type ModelPrice = {
  inputPerMillion: number
  outputPerMillion: number
}

/**
 * The price list, and **it SHRANK at M1 rather than growing** (ADR-0027).
 *
 * The M0 note here predicted it would grow when real models arrived. It did not, because
 * the provider reports `usage.cost` per call — verified denominated exactly 1:1 in USD
 * against three models with a real key on 2026-08-29 — so cost became a fetch rather than
 * a literal somebody has to maintain. A hand-kept price list across the catalogue a model
 * picker implies is wrong within a week of being written, and `priced: false` would have
 * become the normal case instead of the exception it is designed to be.
 *
 * What remains is the one model no provider prices for us: the fake, which is genuinely
 * free. Keeping the entry is what makes its zero mean "measured as free" rather than
 * "unknown" — the distinction `priced` exists for.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'fake:deterministic': { inputPerMillion: 0, outputPerMillion: 0 },
}

export type CallCost = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /**
   * Billed deliberation, where the provider reported any. Absent when it did not, which is
   * not the same claim as zero.
   *
   * It is not folded into `outputTokens` because it is the part of the bill we cannot
   * see: a model with mandatory reasoning deliberates privately, we pay, and none of it
   * can be stored or shown to an annotator (ADR-0022). Measured 2026-08-30, one model's
   * own effort dial moved this from 0 to 269 tokens and its cost by 1.8x, so it is the
   * difference between a bill that is explicable and one that is merely correct.
   */
  reasoningTokens?: number
  /** US dollars for this one call. Zero when unpriced — see `priced`. */
  costUsd: number
  /**
   * Whether `costUsd` is a real figure or a placeholder for a model with no price on
   * file. Reported rather than guessed: an invented rate produces an invoice that is
   * confidently wrong, which is worse at billing time than a gap that is visibly a gap.
   */
  priced: boolean
}

/** Cents-of-a-cent precision. Enough for a single call; short of float noise. */
const round = (value: number): number => Math.round(value * 1e8) / 1e8

/**
 * What one call cost.
 *
 * **The provider's own figure wins when there is one** (ADR-0027). It is authoritative in a
 * way an arithmetic reconstruction cannot be: it already accounts for cached input, tiered
 * and per-endpoint rates, and reasoning tokens billed at rates the catalogue does not
 * publish. Recomputing it from a table would be inventing a second, quieter answer to a
 * question the provider already answered.
 *
 * `reportedUsd` is optional rather than required because not every adapter has one — the
 * fake has no bill at all — and because a provider may omit it on any given response.
 */
export const costOf = (model: string, usage: TokenUsage, reportedUsd?: number): CallCost => {
  const totals = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.input + usage.output,
    ...(typeof usage.reasoning === 'number' ? { reasoningTokens: usage.reasoning } : {}),
  }

  // `priced` is true here for the same reason it is true for the fake: somebody who knows
  // told us. A zero that was reported and a zero that was assumed are different claims,
  // and M2's metering must not sum them as if they were one.
  if (typeof reportedUsd === 'number' && Number.isFinite(reportedUsd)) {
    return { ...totals, costUsd: round(reportedUsd), priced: true }
  }

  const price = MODEL_PRICES[model]
  if (price === undefined) return { ...totals, costUsd: 0, priced: false }

  return {
    ...totals,
    costUsd: round(
      (usage.input / 1_000_000) * price.inputPerMillion +
        (usage.output / 1_000_000) * price.outputPerMillion,
    ),
    priced: true,
  }
}
