# ADR-0077: `metadata` is withheld from the annotator payload

**Status:** Accepted · **Date:** 2026-09-19 · **Milestone:** M5 (phase 4)

## Decision
The annotator surface never receives a trace's `metadata`; the console shows it.

## Context
`metadata` is bookkeeping that may carry customer ids and plays no part in judging. ADR-0067's default applies: what the annotator surface never receives, it cannot leak.

Plan: `thoughts/shared/plans/approved/2026-09-19_evaluate-native-shapes.md` (decision 8)
