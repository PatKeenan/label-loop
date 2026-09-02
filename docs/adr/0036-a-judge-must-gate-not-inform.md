# ADR-0036: A judge must gate, not inform — the second bar, stated

**Status:** Accepted · **Date:** 2026-09-01 · **Milestone:** M5
**Makes explicit:** a test ADR-0034 states but applies only to polarity

## Decision

A judge is valid only if it clears **two independent bars**:

1. **It is expressible.** Answering `true` either passes or fails (ADR-0034).
2. **It evaluates rather than works.** The call must gate something the caller's system
   produced, not produce a fact that system needs.

The second bar is stated here because ADR-0034 wrote the test and turned it only on the
polarity enum. **"Is it a failure mode?" does not answer it.** A failure mode of the
caller's system can still be a fact we are being asked to manufacture for them.

## Context

ADR-0034 draws the line in a table: an agent drafting a reply and calling `is-on-brand`
before sending is evaluation, because it gates; an agent receiving a ticket and calling
`is-bug` to route it is work, because it produces a fact their system needs. It then removes
`does_not_score` and declares three of the four seeded judges unexpressible.

The count was wrong, and the fourth judge is why. `needs-human` — *"Does this issue need a
maintainer to read it before any automated reply?"* — carries `polarity: fails` and a
weight, so it clears bar 1 and the enum change never touches it. Asked of a raw inbound
issue it is squarely the second row of ADR-0034's own table: the caller's bot routes on the
answer. It is a real failure mode of a triage system and still the wrong thing for us to
run.

Being expressible under the enum is not the same as being an evaluation, and nothing in the
schema can tell them apart. Polarity is checked by a Postgres enum; this is checked by
whoever authors the judge, which is exactly why it needs writing down rather than leaving
implicit in a table inside another ADR.

ADR-0034 reaches the same verdict on the seeded panel by a different route — it needs
replacing because *"the artifact it judges is a raw GitHub issue rather than anything a
customer's agent produced"* — so this is a sharpening of that ADR, not a reversal of it. No
amendment is owed.

## The same judge, moved across the line

The customer need does not disappear; it is expressed as evaluation:

```
artifact:  the inbound issue
context:   { routed_to: "needs_human" }
judge:     mis-routed — "Does the routing decision in context misjudge this issue?"
polarity:  fails
```

`true` means their agent got it wrong. That gates, it is alignable against an expert, and it
is what error analysis over their traffic would actually surface.

## Consequences

- **Every judge authored from M6's taxonomy is checked against both bars**, not just
  polarity. Axial coding produces failure modes, and a failure mode can still fail bar 2.
- **P2's scope grows**: choosing the seeded panel's judges is now two questions per
  candidate, not one.
- **A judge failing bar 2 usually has an evaluation form**, reached by moving the caller's
  own determination into `context` and asking whether it is wrong. That is a design move
  worth trying before rejecting a customer's use case.
- `needs-human` survives P1 only because a panel with no judges makes `evaluate` throw
  `NOT_FOUND`. It is deleted at P2, and the seed says so in a comment.

Plan: `thoughts/shared/plans/approved/2026-09-01_p1-two-valued-polarity.md`
Provenance: `thoughts/shared/research/2026-08-31_adr-0034-two-valued-polarity.md` (D12)
