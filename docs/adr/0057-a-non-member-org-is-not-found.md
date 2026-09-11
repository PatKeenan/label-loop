# ADR-0057: A non-member organisation is NOT_FOUND, never FORBIDDEN

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
A request naming an org the signed-in account is not a member of — or an org that does not exist — answers `NOT_FOUND`. The two cases are indistinguishable, and asserted to be.

## Context
Making the org explicit (ADR-0047) removes the automatic filtering that made the single-org read safe, so the refusal's wording becomes a disclosure decision.

It matches the posture `api-key-auth.ts` already takes, where a key scoped to a different panel is refused as `UNAUTHORIZED` rather than `FORBIDDEN` so the response does not confirm the other panel exists. Both auth paths now refuse the same way. The cost is a less helpful message for a member of another org who followed a stale link.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
