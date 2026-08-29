# ADR-0025: The model pin's concrete shape

**Status:** Accepted · **Date:** 2026-08-29 · **Milestone:** M1

## Decision
ADR-0022 established that a frozen judge version pins a capability contract; this fixes its
shape. `model_pin` is jsonb carrying `capabilities`, `data_collection` (ADR-0023), an
**optional** `quantizations`, and `reasoning: { effort }`. Three rules follow:

- **`quantizations` is optional; omitted means unconstrained.** Proprietary hosted routes have
  no quantization variance, so naming one there would be a constraint with nothing to bind. It
  binds where it is written, which is the open-weights case ADR-0022 was actually about.
- **Every `llm` judge carries a pin, `fake:` ones included**, so the CHECK is ADR-0022's clean
  mirror of the model/type rule rather than a route-conditional special case.
- **`reasoning.effort` is always present and always a concrete literal.** There is no
  "inherit the provider's default".

## Context
ADR-0022 deliberately left the shape to M1's plan. The reasoning rule is the sharp one: 83 of
396 catalogued models have `reasoning.mandatory: true`, and all three seed models default
`enabled` with *differing* efforts. A pin that omits the field is a pin whose meaning changes
when the provider changes its default — the exact drift a frozen `jdv_` exists to prevent.

## Consequences
- `google/gemini-3.7-flash` has mandatory reasoning, so it is pinned to its own default effort
  **read once and written as a literal**. If the provider later moves that default, ours does
  not move, and the divergence is visible rather than silent.
- The `fake:` pin records `data_collection: 'deny'` like every other row. The redundancy is
  the point (ADR-0023): it is what makes a future exception auditable.

Full rationale: `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` (P1, P5, Decisions 2, 13, 17).
