# ADR-0075: The evaluate payload is capped at 64 KiB serialised

**Status:** Accepted · **Date:** 2026-09-19 · **Milestone:** M5

## Decision
`input`, `output`, `reference` and `metadata` together may not exceed 64 KiB of serialised JSON; over the cap is a field-level 422. Raise it when a real integration hits it.

## Context
With any-JSON roles a per-field string length no longer bounds anything. Everything under the cap goes into every judge's prompt (~16k tokens at 64 KiB against ~25k at 100 KiB), and raising a cap later breaks no caller while lowering one does.

Plan: `thoughts/shared/plans/approved/2026-09-19_evaluate-native-shapes.md` (decision 4)
