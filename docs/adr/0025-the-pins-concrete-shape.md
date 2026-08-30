# ADR-0025: The model pin's concrete shape

**Status:** Accepted (amended 2026-08-30: the effort vocabulary widened) · **Date:** 2026-08-29 · **Milestone:** M1

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

## Amendment 2026-08-30 — `reasoning.effort` takes seven values, not four
The original four (`none`, `low`, `medium`, `high`) did not cover the vocabulary the
catalogue actually uses. Measured against the live models API on 2026-08-30: `minimal` is
supported by 29 models, `xhigh` by 53, `max` by 47 — and **20 models DEFAULT to one of the
three.**

That is not a cosmetic gap, because of this ADR's own rule. "Read `default_effort` and
write that concrete value into the pin" is unsatisfiable when the value cannot be
represented, so those 20 models were **unpinnable** — and for the ones whose reasoning is
also mandatory, unusable outright. `google/gemini-3.5-flash-lite` is the concrete case:
`mandatory: true` with `default_effort: 'minimal'`, so it could be neither disabled nor
pinned to its own default.

The set is now `none · minimal · low · medium · high · xhigh · max`, ordered ascending.
`none` and `minimal` are deliberately distinct: `none` disables deliberation, `minimal` is
the least a model that cannot be silenced will do — collapsing them would re-create exactly
the hole this amendment closes.

Widened **before P4 wrote the migration**, which is the only reason it was cheap. The column
is frozen by ADR-0003 once written, so the same fix a week later is a migration plus an
audit of which judges predate it. Stakeholder decision, 2026-08-30.

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
