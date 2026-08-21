# ADR-0012: Resilience primitives are hand-rolled, never libraried

**Status:** Accepted · **Date:** 2026-08-21

## Decision
Timeout, retry with exponential backoff and jitter, circuit breaking, and later
backpressure and rate limiting are written in this codebase rather than imported from a
resilience library. A standing principle, not a one-off for the first provider.

## Context
CONVENTIONS.md names this helper as architecture wearing a small hat: it sits inside
`llm/`, the single gateway every provider call passes through. Keeping the behaviour
explicit means its conduct under failure is inspectable and testable rather than
delegated, and with an injected `Clock` it is deterministic to test without sleeps.

## Consequences
- M0 ships only timeout + retry/backoff+jitter + breaker around the fake provider.
  Backpressure and per-key rate limiting are M2 and must not leak forward.
- Any future resilience library would be an architectural seam and therefore a
  STACK_DECISIONS row, not a casual dependency.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-F)
