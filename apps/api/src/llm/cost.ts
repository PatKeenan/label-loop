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
 * The price list. One entry at M0, because M0 has one provider and it is free.
 *
 * A table rather than a field on the judge config: prices change without the judge
 * changing, and a price baked into an immutable `jdv_` would freeze the wrong thing. When
 * real models arrive at M1 this grows; when prices move it will need to become versioned
 * and dated, which is M2's metering problem rather than a shape to guess at now.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'fake:deterministic': { inputPerMillion: 0, outputPerMillion: 0 },
}

export type CallCost = {
  inputTokens: number
  outputTokens: number
  totalTokens: number
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

export const costOf = (model: string, usage: TokenUsage): CallCost => {
  const price = MODEL_PRICES[model]
  const totals = {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.input + usage.output,
  }

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
