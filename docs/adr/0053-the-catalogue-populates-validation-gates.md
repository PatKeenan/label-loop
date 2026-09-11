# ADR-0053: The catalogue populates the picker; the validating call gates it

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The model picker is populated from the provider's catalogue but gated exclusively by ADR-0026's real validating call. No model is offerable because `supported_parameters` advertises a capability.

## Context
`supported_parameters` is a UNION across endpoints — `anthropic/claude-sonnet-5` advertised structured output while three of its nine endpoints could not do it — and a capability flag is not a guarantee of constraint enforcement: `claude-haiku-4.5` advertises `structured_outputs`, is sent `maxLength: 280` under `strict: true`, and broke the output contract on four attempts out of four.

Two things the picker must therefore not claim: it cannot gate on `data_collection`, which no catalogue field exposes (ADR-0023); and it must not warn "this model always reasons" from `reasoning.mandatory`, which would be false for `gemini-3.5-flash-lite` — mandatory, and 0 reasoning tokens at `minimal` across three runs. Evidence: `thoughts/shared/research/2026-08-30_model-tier-measurements.md`.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
