# ADR-0037: The triage persona returns, as a gate on the caller's own routing

**Status:** Accepted · **Date:** 2026-09-04 · **Milestone:** M5
**Revises a recorded cost of:** ADR-0034 · **Applies the design move in:** ADR-0036

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-04_p3-polarity-prose.md`. Expand if the decision
> is challenged or its consequences grow.

## Decision

The **triage** persona (PRODUCT §3, README "Who it is for") is rewritten into its evaluation
form rather than deleted. The panel gates the triage bot's **own routing decision**: the
inbound issue is the artifact, the route the bot chose goes in `context`, and `mis-routed`
(`polarity: fails`) asks whether that decision misjudges the issue. `true` means their agent
got it wrong.

Every judge named in the persona clears both bars — expressible (ADR-0034) and gating rather
than working (ADR-0036) — checked individually. Naming one judge is the correct answer if one
is what clears them; the old bullet's four-judge parallel with the **taste** persona is not
worth a judge that does not. The taste persona is untouched.

## Context

ADR-0034 recorded, as an accepted cost, that *"a real use case leaves the product
entirely"* — the labelling customer — and ADR-0036 then observed that a judge failing the
gate-not-work bar *"usually has an evaluation form, reached by moving the caller's own
determination into `context` and asking whether it is wrong."* This decision applies that
move to the product's own stated personas, so the customer ADR-0034 wrote off returns in a
shape V1 can actually serve, rather than the product shipping one persona and a silence
where the other was.

## Consequences

- **ADR-0034's cost section is narrower than it reads.** The labelling customer does not
  leave; the classification-shaped *call* does. Worth saying, because the two are easy to
  conflate and ADR-0034's own wording invites it.
- **The artifact is still something the caller did not produce** — an inbound issue. What
  moves it across the line is `context` carrying their determination, so any restatement of
  this persona that drops `context` has silently restored the classification shape.
- **A product decision ships inside a prose PR**, which is why it is recorded here rather
  than left in the plan.

Plan: `thoughts/shared/plans/approved/2026-09-04_p3-polarity-prose.md`
Provenance: `thoughts/shared/research/2026-09-04_p2-voice-panel-seed.md`
