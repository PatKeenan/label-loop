# ADR-0024: A provider failure that cannot self-heal gets its own kind

**Status:** Accepted · **Date:** 2026-08-29 · **Milestone:** M1

## Decision
`ProviderFailureKind` gains a fourth member, `misconfigured`, for provider failures that no
retry and no recovery window can fix: a rejected credential (401), an exhausted balance (402),
and a request the provider itself calls malformed (400 without moderation metadata). It is
`RETRYABLE: false` and `AFFECTS_HEALTH: false`, maps to the existing `INTERNAL` code so no
published contract changes, **must set `cause`** so `evaluate.ts` forwards it to the error
reporter, and is logged at **`error`** rather than `warn`. It carries its own `failure_kind`
span attribute, and is deliberately **not** surfaced on `/readyz`.

## Context
Before this, 401 and 402 fell into `unavailable`: three retries, a per-model circuit whose
half-open probe can never succeed, and a `PROVIDER_UNAVAILABLE` with a `Retry-After` telling
the customer to retry something that cannot succeed. CONVENTIONS defines `error` as
alert-worthy, and this never self-heals and takes every judge down at once.

## Consequences
- M3 dashboards can separate "the provider is flaky" from "we did not pay the bill"; this is
  the strongest candidate for M3's one alert rule.
- Readiness stays honest: the console and trace explorer are fine, and marking the instance
  unready would produce a restart loop over a condition no restart fixes.
- Rejected: throwing a plain non-`ProviderError` to get no-retry and Sentry reporting for
  free. It works, and it routes a known condition through the port's documented bug path.

Full rationale and the complete failure-mapping table: `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` (P2, Decision 5).
Provenance: `thoughts/shared/research/2026-08-28_m1-endpoint-spine.md` (D6).
