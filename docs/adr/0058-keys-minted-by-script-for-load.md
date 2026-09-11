# ADR-0058: Keys are mintable by script, through the console’s own service

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
`scripts/mint-keys.ts` mints N API keys through the same service the console calls, so a load harness needs no session, no CORS and no new API surface.

## Context
`docs/BREAKING_POINT.md` v0 reports a limiter bound rather than a saturation point, because one key at 60/minute cannot exceed roughly one served request per second — §6 calls this the single largest gap and §8 ranks minting many keys first among what would make v1 worth reading.

Rejected: having k6 sign in and drive `/internal` directly, which couples the load harness to session auth and CORS; and deferring the question to whoever attempts v1, which would mean building the door under time pressure. The seam is nearly free while the service is being written. Producing BREAKING_POINT v1 itself remains out of M4's scope.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
