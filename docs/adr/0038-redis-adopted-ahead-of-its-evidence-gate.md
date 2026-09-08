# ADR-0038: Redis is the rate-limit counter store, adopted ahead of its own evidence gate

**Status:** Accepted · **Date:** 2026-09-04 · **Milestone:** M2
**Amends:** STACK_DECISIONS **D4**

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-04_m2-resilience-load-baseline.md`. Expand if the
> decision is challenged or its consequences grow.

## Decision

**Redis is the counter store for per-key rate limiting, chosen ahead of the evidence D4 asks
for.** The sequencing trap is real — the document that would justify it is produced by the
milestone that needs it — so it is cut rather than solved, and D4 is amended to say exactly
that rather than being left to contradict the build. Stakeholder decision, 2026-09-04.

D4 becomes a decided row naming Redis, the date, that the decision was taken on design
grounds ahead of its own evidence gate, and why. pg-boss stays on Postgres; this does not
touch the queue.

## Context

D4 reads *"no Redis until the k6 breaking-point doc proves the need"*, but
`docs/BREAKING_POINT.md` is an M2 deliverable produced by the very milestone that needs the
store — so the gate can never open on its own terms, and the knot is cut on design grounds
with the reversal recorded rather than glossed.

## Consequences

- **`docs/BREAKING_POINT.md` must still report what the numbers actually show**, including
  that a single instance never needed Redis if that is what phase 3 measures. The document
  and the amended D4 have to agree rather than quietly imply evidence neither has.
- **The reversal is what makes [ADR-0039](0039-hand-rolled-bucket-delegated-storage.md)'s
  port load-bearing**: a store chosen ahead of its evidence must stay swappable.
- A new container in every local stack and in CI, and a second data store to reason about at
  M3's observability and M8's deploy.

Plan: `thoughts/shared/plans/approved/2026-09-04_m2-resilience-load-baseline.md`
Provenance: `thoughts/shared/research/2026-09-04_m2-resilience-load-baseline.md`
Log: `thoughts/shared/progress/decisions-log.md` (2026-09-04) · Register: STACK_DECISIONS D4 (amended)
