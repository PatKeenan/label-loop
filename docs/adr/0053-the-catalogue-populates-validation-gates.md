# ADR-0053: The catalogue populates the picker; the validating call gates it

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The model picker is populated from the provider's catalogue but gated exclusively by ADR-0026's real validating call. No model is offerable because `supported_parameters` advertises a capability.

## Context
`supported_parameters` is a UNION across endpoints — `anthropic/claude-sonnet-5` advertised structured output while three of its nine endpoints could not do it — and a capability flag is not a guarantee of constraint enforcement: on 2026-08-30 `claude-haiku-4.5` advertised `structured_outputs`, was sent `maxLength: 280` under `strict: true`, and broke the output contract on four attempts out of four.

**Amended 2026-09-13: the haiku example is now HISTORICAL, and that is a fix rather than a retraction.** Verified against the live API during M4 phase 2's validation check, `claude-haiku-4.5` now passes — `ok: true`, 3 endpoints surviving the pin, served by `anthropic/claude-4.5-haiku-20251001`. The reason is a deliberate change made on 2026-08-31, one day after the measurement: `RATIONALE_TARGET_LENGTH` (280, stated in the PROMPT where a model can act on it) was split from `RATIONALE_MAX_LENGTH` (1000, the refusal bound), and `judge-schema.ts` sends no `maxLength` at all. Structured output constrains SHAPE, not size, so the original cap was advisory on the wire and absolute on the way back in — a model was never told the limit and was then refused for exceeding it.

**The correction already existed in this repository when this ADR was written.**
`apps/api/src/llm/validate-pin.test.ts` records the re-measurement — *"told one, it returned 185-296 on 5 of 5 (re-measured 2026-08-31)"* — and `thoughts/shared/plans/complete/2026-08-29_m1-endpoint-spine.md` says the same. This ADR was written on 2026-09-11 and reached back past both to the 2026-08-30 figure. **The failure mode here is not a model changing behaviour; it is a newer document citing an older measurement across a correction it did not look for.** Worth naming, because nothing about an accepted ADR makes it re-check its own evidence.

**The decision is unchanged, because it never rested on that example.** Its other leg is untouched: `supported_parameters` is still a union across endpoints, and no catalogue field predicts how many survive a pin. The passing call demonstrates this better than the failure did — the catalogue can say haiku exists and advertises structured output; only a real call says three of its endpoints satisfy this pin and which one answered.

Two things the picker must therefore not claim: it cannot gate on `data_collection`, which no catalogue field exposes (ADR-0023); and it must not warn "this model always reasons" from `reasoning.mandatory`, which would be false for `gemini-3.5-flash-lite` — mandatory, and 0 reasoning tokens at `minimal` across three runs. Evidence: `thoughts/shared/research/2026-08-30_model-tier-measurements.md`.

Plan: `thoughts/shared/plans/complete/2026-09-11_m4-console-auth.md` (Decisions made)
