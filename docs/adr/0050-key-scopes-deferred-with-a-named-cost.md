# ADR-0050: Key scopes are deferred, and the cost is named

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
`api_keys` gains no `scopes` column at M4. Keys issued by the console are implicitly `evaluate`-only. PRODUCT 5.1's `evaluate`/`read`/`manage` split, and the ADR-0003 amendment it requires, arrive with the management API.

## Context
PRODUCT 5.1 requires scopes "before the management API ships", and the parking lot parks that API until enterprise pull under a dashboard-first promotion rule — so M4's console-only management does not trigger the requirement.

Accepted cost, stated rather than implied: M4 is the milestone that starts minting keys in volume, so every key issued before scopes arrive needs a backfill. This runs against the precedent of `org_members.role` and `judge_versions.required`, both of which shipped early and unenforced precisely to avoid a backfill; the difference was judged acceptable and is recorded here so it is a decision rather than an oversight.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
