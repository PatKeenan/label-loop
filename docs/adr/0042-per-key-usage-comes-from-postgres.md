# ADR-0042: Per-key usage is read from Postgres; no identifier is ever a metric label

**Status:** Accepted · **Date:** 2026-09-08 · **Milestone:** M3

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`. Expand if the decision is challenged or its consequences grow.

## Decision

**Per-key usage is queried from Postgres, and no key id, org id, panel id, trace id or
artifact-derived value may ever appear as a metric label.** Stakeholder decision, 2026-09-08.

`docs/CONVENTIONS.md` gains a **Metrics** section stating the naming rules and the label
allow-list, and **a test enforces it** — the same posture as ADR-0016's machine-enforced
architecture rules.

## Context

`docs/SENIORITY_CHECKLIST.md` requires a per-key usage dashboard and PRODUCT 5.10 wants
`org → panel → judge → key` drill-down. Expressing that as Prometheus labels means unbounded
cardinality: fine against today's single seeded key, a liability the moment keys are minted by
customers.

## Consequences

- **The risk is removed rather than deferred.** The label that would have carried it is never
  created, so there is nothing to walk back later.
- **The panel reads from the same source M8's billing must read from.** A dashboard is not an
  invoice, and usage that bills someone has to come from a durable record, not from a metrics
  store with retention.
- A SQL `GROUP BY` costs a query; a Prometheus label costs a time series forever. Grouping by
  key is therefore safe in SQL in a way it never was in a metric.
- **The rule's violation is silent and its reversal is breaking** — a label cannot be dropped
  without breaking every dashboard built on it — which is why it is tested rather than trusted.
- Grafana needs a database credential, which is [ADR-0045](0045-a-read-only-database-role.md).
- Open, and named in the plan: whether `traces` needs an index before a dashboard groups by
  key on the hot path's own database.

Plan: `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`
Provenance: `thoughts/shared/research/2026-09-08_m3-observability.md`
Related: ADR-0041, ADR-0045, ADR-0016, ADR-0003
