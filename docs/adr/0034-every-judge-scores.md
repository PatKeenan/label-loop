# ADR-0034: Every judge scores — classification leaves the product

**Status:** Accepted · **Date:** 2026-08-31 · **Milestone:** M5
**Amends:** ADR-0019 (what the product is)

## Decision

**Judge polarity is two-valued.** Answering `true` either passes or fails. The third value,
`does_not_score`, is removed, and with it the ability for a panel to carry a judge that
contributes to nothing.

Every judge in a panel therefore has a weight, participates in the score, and can fail the
panel. `passed` is null for exactly one reason — the judge did not run (`skipped`, `failed`)
— rather than two.

**This narrows ADR-0019 deliberately, and the narrowing is the point.** That ADR says triage
and taste validation are the same operation and that *"where the artifact came from — the
caller's agent generated one, a user filed the other — is not a property of our system."*
Under that sentence, a customer calling us to LABEL their inbound tickets is a legitimate
customer. **From V1 they are not.** We validate a customer's agentic system; we do not
perform steps inside it.

## Context

### The pipeline cannot produce a non-scoring judge

This is the argument that settles it, and it is structural rather than aesthetic. There is
exactly one path by which a judge comes into existence (PRODUCT.md:38-40, BUILD_SPINE M6):

> open coding (**failure** notes) → axial coding into a versioned **failure** taxonomy →
> *"each category's judge is configured from the taxonomy + rubric"*

Every category in a failure taxonomy is a failure mode, and a failure mode is inherently
pass/fail — that is what makes it a failure. No step in that pipeline emits `is-bug`.

So a `does_not_score` judge can only ever be **hand-written, outside the flywheel** — which
is precisely what the four seeded judges are: fixtures typed into `scripts/seed.ts` at M0,
months before the pipeline they are supposed to illustrate existed. They are not a product
capability. They are scaffolding that outlived its purpose and was mistaken for a feature.

Supporting a polarity nothing can generate means carrying a code path nothing feeds.

### Judging versus doing

A judge legitimately sits inside the caller's production path — ADR-0019's *"one call inside
their loop"* is unchanged. What matters is what the call is FOR:

| The call | What it is |
|---|---|
| Agent drafts a reply → `is-on-brand` before sending | **Evaluation.** It gates. |
| Agent receives a ticket → `is-bug` to route it | **Work.** It produces a fact their system needs. |

Same endpoint, same latency, different product. The second is classification-as-a-service
wearing a judge's clothes, and it is the shape ADR-0019 spent its whole Context section
moving away from — `classifier` was rejected as a name because it *"implies a single
multi-class output"*, `cls_`/`clv_` were retired, and the endpoint was rebuilt around
per-judge verdicts. Retiring the noun and keeping the capability left the product saying one
thing and demonstrating another.

### The same need, expressed as evaluation

A customer whose agent triages tickets is well served, and the judge scores:

```
artifact:  "The export button does nothing when clicked…"
context:   { agent_label: "feature_request" }
judge:     mis-classified — "Does the label in context misdescribe this issue?"
polarity:  fails
```

`true` means their agent got it wrong. That is a failure mode, it is what axial coding over
real error analysis would actually surface, and it is alignable against an expert — none of
which is true of `is-bug`.

### A simplification falls out

ADR-0019 introduced `status` partly to disambiguate the two reasons `passed` can be null:
informational, or never ran. With `does_not_score` gone there is one reason, so the meaning
of a null `passed` collapses. `status` still earns its place for `skipped` and `failed`.

## What this costs, recorded rather than waved away

- **A real use case leaves the product.** A customer wanting routing labels and a quality
  gate over one artifact in one call is no longer served — not by two panels, but at all.
  That is the intended effect, not a side effect: they want a classifier, and V1 is not one.
- **The seeded panel becomes invalid, not merely weak.** Three of its four judges are
  unexpressible under this ADR, and the artifact it judges is a raw GitHub issue rather than
  anything a customer's agent produced. It needs replacing, not editing.
- **It reopens the dogfooding tenant.** BUILD_SPINE M5 names *"this repo's GitHub issues
  judged by a panel"*, which is the classification shape. What this repo's own agentic
  system produces — and what an expert would judge about it — is now an open question.
- **A migration, and one that must land before M5 seeds real data.** Postgres adds enum
  values easily and does not remove them, so `judge_polarity` is recreated and the column
  swapped, plus a rewritten `judge_versions_weight_matches_polarity` CHECK (weight becomes
  unconditionally NOT NULL and positive). Cheap now, when every database is a local one
  thrown away by `docker compose down -v`; not cheap after M5 has annotations FK'd to judge
  versions.

Rejected alternatives:

- **Status quo — keep three values and document polarity better.** The evidence against is
  that the stakeholder who commissioned the design misread a correct response as broken. If
  the author cannot read the output, an integrator cannot.
- **Homogeneous panels by convention** — a panel scores or it labels, enforced by nobody.
  Leaves the code path in place and adds a rule to remember, which is the combination
  CONVENTIONS exists to avoid.
- **Labels as a separate concept beside judges** — reintroduces approximately the
  classifier/judge split ADR-0019 retired, for a capability V1 has now decided against.
- **Wiping the migration stream instead of migrating.** Considered because nothing is
  deployed and every database is disposable. Rejected: the forward migration is about twelve
  lines, while a wipe means rebuilding drizzle-kit's entire `meta/*_snapshot.json` chain —
  more work, not less — and the stream carries substantial recorded reasoning (`0005`
  alone is an essay on why immutability is a grant rather than a convention). Forward-only
  is a CONVENTIONS rule, and the first time it is inconvenient is the wrong time to discover
  it is negotiable.

## Open questions this does not settle

- **What the seeded panel becomes.** It must judge something a system produced, with judges
  that all score. It is also the first thing anyone sees in the README walkthrough, so it is
  the product's shop window.
- **The dogfooding tenant (M5).** Judging this repo's issues is the classification shape.
  Judging what this repo's own agents produce is the evaluation shape, and is a better story.
- **Whether `weight` should stay nullable in the contract** now that every judge carries one.

Provenance: `thoughts/shared/progress/decisions-log.md` (2026-08-31).
