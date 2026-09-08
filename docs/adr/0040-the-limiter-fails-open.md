# ADR-0040: The rate limiter fails open

**Status:** Accepted · **Date:** 2026-09-04 · **Milestone:** M2
**To be revisited at:** M8 (per-org `QUOTA_EXCEEDED`)

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-04_m2-resilience-load-baseline.md`. Expand if the
> decision is challenged or its consequences grow.

## Decision

**The limiter fails OPEN when Redis is unreachable**, logging a warning with the subject and
reporting to the `ErrorReporter` port. Stakeholder decision, 2026-09-04. A limiter outage
becoming a service outage is a worse failure than a brief window of unlimited traffic, and
M2's whole subject is graceful degradation. A store error must never surface as a 500: a
broken limiter is our problem, not the caller's.

**Rate limiting runs after authentication, and the order is tested.** Limiting first would
let an anonymous flood consume a real key's allowance.

## Context

M2 adds a second data store to the request path, and the choice of what happens when it is
unreachable is the difference between a resilience layer and a new single point of failure.

## Consequences

- **The cost, recorded rather than waved away:** during a Redis outage there is no bound on
  traffic at all. That is acceptable precisely because this limit is about throughput
  fairness and not about cost.
- **It stops being acceptable the day the limiter is load-bearing for spend** — which is what
  per-org `QUOTA_EXCEEDED` at M8 will be. **M8 must revisit this decision rather than inherit
  it.**
- **A fail-open limiter is invisible when it breaks**, so the warning log and the Sentry
  report are the decision's other half, not decoration — and the fail-open path is asserted
  directly in tests, because it only ever runs when something is already wrong.

Plan: `thoughts/shared/plans/approved/2026-09-04_m2-resilience-load-baseline.md`
Provenance: `thoughts/shared/research/2026-09-04_m2-resilience-load-baseline.md`
Related: ADR-0038, ADR-0039, ADR-0012
