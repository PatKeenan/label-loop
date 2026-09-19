# ADR-0076: Judges see one provider-neutral rendering; the prompt change is not versioned

**Status:** Accepted · **Date:** 2026-09-19 · **Milestone:** M5

## Decision
One pure `render-for-model` function in `llm/` turns the four roles into the judge prompt, and every provider adapter uses it. Every existing judge's prompt changes with this plan; the change is recorded here, not versioned through ADR-0033's templates.

## Context
The prompt should be the same whatever the provider. ADR-0033's versioned templates were never built, and only seed and test judges exist, so building them now would protect nothing. Revisit when a real customer judge would be affected.

Plan: `thoughts/shared/plans/approved/2026-09-19_evaluate-native-shapes.md` (decisions 5, 6)
