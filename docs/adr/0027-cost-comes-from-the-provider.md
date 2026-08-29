# ADR-0027: Cost is sourced from the provider and stored as `numeric`

**Status:** Accepted · **Date:** 2026-08-29 · **Milestone:** M1

## Decision
`costOf` prefers the provider's own per-call figure and reports `priced: true` only when it
has one, falling back to the table otherwise. `MODEL_PRICES` **shrinks to the `fake:` entry**
rather than growing. `trace_verdicts` gains `input_tokens`, `output_tokens`,
`reasoning_tokens`, `cost_priced`, and `cost_usd` as **`numeric`, never `real`**.

## Context
ADR-0021 said the hand-maintained price literal does not survive M1 and left the sourcing
question open. It is now settled empirically: `usage.cost` was verified denominated exactly
1:1 in USD against three models with a real key on 2026-08-29. `cost_usd` is money that M2's
metering sums, and float4 loses the cents-of-a-cent precision `cost.ts` already rounds to.

## Consequences
- `priced` stays an honest signal rather than becoming the normal case: zero from a genuinely
  free fake and zero from a model with no price on file remain distinguishable.
- `reasoning_tokens` is stored whether or not the deliberation is visible to us, so cost per
  verdict stays explicable (ADR-0025).
- A catalogue is not needed for cost, which is one of the three reasons M1 ships without one.

Full rationale: `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` (P3, Decisions 9, 10).
