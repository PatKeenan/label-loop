# ADR-0082: An annotation set is capped at 250 traces

**Status:** Accepted · **Date:** 2026-09-20 · **Milestone:** M5 (phase 7)

> **Renamed 2026-09-21 (ADR-0085).** "Review set" is now **annotation set**, and the file name
> with it. The decision below is unchanged; only its noun is.

## Decision
`ANNOTATION_SET_MAX_SIZE` is 250, in `@labelloop/contracts` so both sides read one number.

## Context
Saturation is what bounds a pass, not stamina: PRODUCT 5.6 drives taxonomy size by the point where
new traces stop producing new categories, and past roughly this many they have stopped — so a
larger set pays for attention that finds nothing new. It is also a number a person can finish,
which is what makes "completed" mean something. Raise it if a real pass is still finding
categories at the cap.

Plan: `thoughts/shared/plans/superseded/2026-09-20_review-sets.md` (decision 9), carried into
`thoughts/shared/plans/approved/2026-09-21_annotation-sets.md`
