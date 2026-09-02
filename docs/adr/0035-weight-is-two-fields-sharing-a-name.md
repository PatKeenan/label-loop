# ADR-0035: `weight` is two fields sharing a name

**Status:** Accepted · **Date:** 2026-09-01 · **Milestone:** M5
**Settles:** ADR-0034's third open question

## Decision

`judge_versions.weight` becomes **NOT NULL** — a column-level constraint, not a CHECK — and
positive, enforced by `judge_versions_weight_positive`. Every judge configuration carries a
weight, because every judge scores (ADR-0034).

`Verdict.weight` in the published contract **stays nullable**. It is not the same field.

## Context

ADR-0034 left this open: *"Whether `weight` should stay nullable in the contract now that
every judge carries one."* The question dissolves once the two fields are separated.

`judge_versions.weight` is **configuration** — the customer's declared importance for this
judge, frozen onto an immutable version (ADR-0003). It was nullable only to express a
`does_not_score` judge, which no longer exists, so a null is now unrepresentable rather than
merely unused.

`Verdict.weight` is a **measurement** — the normalised share this judge's answer actually
took of the score on one request. Weights are normalised across the judges that *ran*, not
the ones configured, which is what makes `score` a real number over a smaller set rather
than a diluted one over the full set. A judge that was skipped, failed or errored took no
share, and `null` is the honest value. Returning `0` would be summed by a caller
recomputing the score as a judge that scored nothing, rather than as a judge that did not
score.

**Column-level NOT NULL rather than a CHECK**, deliberately: it flows into Drizzle's
inferred types, so `PanelJudge['weight']` narrows from `number | null` to `number` with no
hand-written union to keep in sync, and an unweighted judge becomes a compile error rather
than a runtime one. The positivity check stays separate because zero is representable and
still meaningless.

## Consequences

- `evaluate.ts` loses its `?? 0` fallbacks; the aggregation reads the weight directly.
- The contract's `weight` description names one reason for null — the judge did not
  contribute — where it previously named two.
- A future judge type that legitimately has no weight needs a migration to re-open the
  column, which is the correct amount of friction.

Plan: `thoughts/shared/plans/approved/2026-09-01_p1-two-valued-polarity.md`
