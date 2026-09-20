# ADR-0074: The native-shapes migration expands, dual-writes, then contracts

**Status:** Accepted · **Date:** 2026-09-19 · **Milestone:** M5

## Decision
The four roles are added as new columns with a backfill; nothing is dropped. `artifact` stays and is dual-written through phases 1–4, so reverting any of them leaves every row readable. The old columns are dropped only in phase 5, after phases 1–4 are verified. Legacy rows keep `input` NULL rather than having one invented from their old context.

## Context
Migrations are forward-only (ADR-0006), and the stakeholder required that existing traces are never removed and every phase is reversible until the last.

Plan: `thoughts/shared/plans/approved/2026-09-19_evaluate-native-shapes.md` (decisions 1, 2, 3)
