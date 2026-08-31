# ADR-0032: The authored prompt is one versioned object on the judge version

**Status:** Accepted · **Date:** 2026-08-31 · **Milestone:** M4
**Amends:** ADR-0003 (what is versioned) · **Complemented by:** ADR-0033 (the template)

## Decision

A judge's authored prompt is a single `prompt` jsonb column on `judge_versions`, holding
**discrete fields** — `question`, `definition`, `rubric`, `examples` — not four columns, and
not one compiled string.

Three rules follow:

- **Compilation is a pure function of those fields.** The request sent to a provider is
  derived from them; the derivation is not stored beside its inputs.
- **The compiled text belongs on the verdict, if it is stored at all** — never on the judge
  version. What was *authored* and what was *sent* are different facts with different
  lifetimes, and the second depends on code that the judge version does not control.
- **The existing `question` column folds into the object.** Left outside, the property this
  ADR exists to create — one referenceable prompt per version — would simply be false.

## Context

PRODUCT.md promises a judge carries *"one binary question with a definition and optional
few-shot examples"* (:34), *"configuration generated from taxonomy + rubric; versioned
(`jdv_`)"* (:96), and an alignment session that ends by *"revis[ing] the rubric and trying
again"* (:103). The schema has exactly one field, `question`
(`packages/db/src/schema/judge-versions.ts:56`), and the rest of the instruction sent to the
model is a hardcoded literal in `apps/api/src/llm/openrouter-provider.ts`. So the loop the
product is built around — align, revise, re-measure — currently has one sentence to revise.

**The `jdv_` is already the version, and that is the whole argument for one column.**
ADR-0003 freezes the row, and `trace_verdicts.judge_version_id` references it `ON DELETE
restrict`, so a stored verdict is one join from the exact prompt that produced it. Four
columns would have required inventing a second version concept — "which prompt version" as a
tuple of four independently-migrating columns, with nothing to point at. One object needs no
such concept, because the row id already is one.

`model_pin` is the in-table precedent (ADR-0022, ADR-0025): a structured jsonb constraint
frozen on this same row, for the same reason — a value split across columns has to be
re-assembled and re-reasoned at every read.

**Fields rather than one compiled string**, for three reasons in descending weight:

1. **`question` is the judge's human-readable identity, not merely prompt input.** The
   annotator screen shows it so an SME can agree or correct against it, the console lists
   judges by it, and a verdict rendered without it is meaningless. Those surfaces need a
   field, not prose to parse back.
2. **Alignment sessions revise specific fields.** "Revise the rubric" has nothing to address
   if the artifact is one string, and a version diff could not say whether the question moved
   or only the examples did.
3. **M6's A/B is designed over fields.** "Same question, different rubric" and "same prompt,
   different model" are the two experiments an alignment session runs; over fields those are
   queries, over prose they are deep diffs.

**Why the deadline is M4 rather than M6.** Adding a column later is an ordinary forward-only
migration (ADR-0006) and costs little. What is not cheap is that M4 freezes the *shape* of a
judge into three public surfaces at once — the judge wizard, `packages/contracts`, and a
published SDK — and CONVENTIONS makes a `/v1` change a new API version rather than an edit.
Deciding this after M4 is a breaking change to a contract we committed to version rather than
mutate.

Rejected alternatives:

- **Four separate columns** — forces a second version concept for a row that is already a
  version, and makes "the prompt at version n" a tuple rather than a value.
- **One compiled prose string** — defeats all three reasons above; in particular it makes the
  judge's question unavailable to the annotator and console surfaces as data.
- **A separate `prompt_versions` table** — a version pointer to a version, when the `jdv_`
  already supplies one.
- **Storing the compiled text on the `jdv_` alongside its inputs** — two sources of truth
  that can disagree, and the compiled text is partly a function of code, so a stored copy
  would look authoritative while not being what was actually sent once that code moved.
  Reinforced on 2026-08-31 by a constraint that settles it: **the artifact and the context
  are per-call**, so a creation-time compile can only ever produce a fragment of the
  request, never the request. A column named for the compiled prompt that structurally
  cannot hold one is the misleading-authority problem in a new place.
- **Compiling in Postgres** — a `STORED` generated column over an `IMMUTABLE` function,
  decided against 2026-08-31. It was a closer call than it looks. A stored generated column
  freezes at write time (`CREATE OR REPLACE FUNCTION` does not recompute existing rows), it
  composes exactly with `0005_immutable_versions.sql`, which `REVOKE`s `UPDATE, DELETE` on
  `judge_versions` from the app role — so the freeze would be a privilege boundary rather
  than a convention — and a rule change would land in the forward-only migration stream,
  dated and reviewable, which is better provenance than an edited string literal. It was
  rejected because it reaches only half the scaffold: `response_format.json_schema` is not a
  function of the judge row, it is generated from `judgeOutputSchema` via `z.toJSONSchema`,
  and hand-writing it into SQL is the "second copy that drifts silently, because both halves
  keep parsing" that `judge-schema.ts` exists to prevent. That unreachable half contains
  `maxLength: 280`, the constant behind the M1/P5 Sonnet failures. Splitting compilation
  across SQL and TS is worse than either alone, and it would cost the offline testability
  every `llm/` test depends on (ADR-0028).

## Consequences

- Migration surface is small: fold `question` in, backfill the four seeded rows, and update
  four call sites (`repositories/panels.ts:29,76,114`, `services/evaluate.ts:107`).
- `packages/contracts` owns the prompt's shape before the database does — it is the single
  source of type truth, and this becomes an API surface at M4's wizard.
- BUILD_SPINE M4 must name the judge authoring surface explicitly; today it says only
  "create panel and judges (wizard → immutable version 1)" and then describes the model
  picker. See `thoughts/shared/research/2026-08-30_genesis-docs-reconciliation.md`.
- A content hash over the prompt object is worth considering, so M6 can ask "same prompt,
  different model" as a query rather than by comparing objects. Not decided here.

## Open questions this does not settle

- ~~**How the compilation rule is identified.**~~ **Settled by ADR-0033**: the rule lives in
  TypeScript as a named, versioned template with slots for the per-call artifact and context,
  and `judge_versions.template` freezes which one a judge uses. This ADR versions *what* was
  said; ADR-0033 versions *how it is assembled*. Together they make a `jdv_` determine its
  own behaviour.
- **Whether `examples` inline their text or reference `tr_` trace ids.** Inlining preserves
  immutability; referencing gives provenance, and M5/M6 will be producing the annotated
  traces that are the natural source. Likely both — inline the text, record the source id.
- ~~**Whether the scaffold gets a version stamped onto each verdict.**~~ **Settled by
  ADR-0033**, and differently than framed here: the identifier is frozen on the judge version
  rather than stamped on the verdict, which a verdict reaches through the `judge_version_id`
  FK it already carries.

Provenance: `thoughts/shared/progress/decisions-log.md` (2026-08-31T13:55Z);
`thoughts/shared/research/2026-08-30_genesis-docs-reconciliation.md`.
