---
date: 2026-09-21T19:00:00Z
author: claude-code
status: draft
milestone: M6
topic: m6-eval-harness
related_adrs: [0003, 0016, 0019, 0022, 0032, 0033, 0034, 0042, 0045, 0060, 0061, 0066, 0073, 0078, 0079, 0081, 0086]
---

# M6 — the eval harness

## Problem
M6 turns M5's free-text failure notes into a versioned taxonomy (`tax_`), authors one judge per
category from it, then measures each judge against held-out human labels in discrete alignment
sessions and gates CI on the result. **Three things block it that are not visible from
BUILD_SPINE**: M6's raw material does not exist yet (one annotation in the dev database, zero
notes), two accepted ADRs it depends on were never implemented (0032, 0033 — there is no rubric
field to revise, and the prompt envelope is a hardcoded literal), and an annotation carries no
link to a judge or category, so "judge-vs-human agreement" has no human side to compare against
until the taxonomy creates one.

## Relevant files and why each matters

**The gap between what is promised and what exists**
- `packages/db/src/schema/judge-versions.ts` — `question` is a bare `text` column; ADR-0032's
  `prompt` jsonb object (`question`/`definition`/`rubric`/`examples`) was never built.
- `apps/api/src/llm/openrouter-provider.ts:80-110` — the prompt envelope, hardcoded in the
  adapter. Its own comment names the problem ADR-0033 exists to fix: *"an unversioned prompt
  fragment that every `jdv_` silently inherits and no version records."* No `template` column,
  no `TEMPLATE_VERSIONS`.
- `apps/api/src/services/evaluate.ts:99` — `code` judges return `failed` with *"not executable
  yet (M5)"*. The triage half of axial coding has no runtime.
- `packages/db/src/schema/annotations.ts` — `outcome` + `note`, with **no judge and no category
  link**. One binary answer about the whole output, not one per failure mode.
- `packages/contracts/src/ids.ts` — `tax_` is reserved, nothing mints it, no table exists.

**What M6 builds on**
- `packages/db/src/schema/trace-verdicts.ts` — the judge side of agreement: `verdict`, `passed`,
  `confidence`, `judgeVersionId` (RESTRICT, so a verdict is one join from its exact config).
- `apps/api/src/services/annotation-queue.ts` — `setProgress` is the one definition of answered
  and done (ADR-0086); M6's judge-disagreement sampler is a fifth picker alongside ADR-0080's four.
- `apps/api/src/services/annotation-sets.ts` — `countingAnswer` already resolves a disagreement
  to one outcome by the dictator rule (ADR-0081). That is the human label alignment measures against.
- `apps/api/src/llm/judge-schema.ts` — structured output derived from the contract; property
  order is load-bearing (reasoning before verdict, ADR-0019).
- `apps/api/src/llm/render-for-model.ts` — the judge-side trace renderer, twin of
  `components/shaped/` (ADR-0078). Where fencing has to land or sit beside.
- `apps/api/src/llm/provider.port.ts:141` — `ModelProvider.evaluate(call: JudgeCall)`. The port
  is judge-shaped; clustering suggestions are not judge calls.
- `.github/workflows/ci.yml` — one `quality` job. The eval gate is a second job with a new shape.
- `apps/web/src/components/shell/section-nav.tsx` — `Taxonomy` and `Alignment` rows sit inert,
  marked M6, beside the now-live `Annotations`.

## Constraints that apply

- **A judge is one failure category, one binary question** (ADR-0019, CONVENTIONS "Data rules").
  Never one judge assessing several criteria — a bundled verdict cannot be measured or attributed.
- **Judges come only from an eval pass** (ADR-0061). The Judges section stays locked until
  annotations-over-traces exist; ADR-0061 says the gate becomes *schema-enforced* at M6, when a
  judge version is required to cite its provenance. Today it is a console rule only, and
  `POST /internal/panels` still accepts free-form judges for seeding.
- **Every judge declares a two-valued polarity** (ADR-0034) and carries a weight > 0. A
  taxonomy-derived judge must produce both; neither is inferable from a category name.
- **Prompts live in versioned judge configs, not in code** (CONVENTIONS "LLM-call rules") — which
  the current envelope violates.
- **No fetch to a provider anywhere but `llm/`, ever** (CONVENTIONS). Clustering and any
  alignment-time model call must go through the gateway, whose port only knows `JudgeCall`.
- **The metric label allow-list is closed** (ADR-0042, machine-enforced). No taxonomy id,
  category id, judge version id or annotator id may become a label. Judge *slug* is allowed.
  A dashboard reads per-judge numbers from Postgres via the readonly role (ADR-0045), never
  from a Prometheus label.
- **Accuracy is never the headline** (PRODUCT 5.7): per-class precision and recall plus Cohen's
  kappa and the sample size. At 3% prevalence a judge that always says "no" scores 97%.
- **Validation is held-out** (PRODUCT 5.7). A judge aligned and measured on the same labels
  reports a number that means nothing.
- **An alignment session is a versioned record** (PRODUCT 5.7a): which `jdv_`, which labeled set,
  what agreement, who ran it, what changed. Re-alignment is expected, not exceptional.
- **Hosted execution of customer code is a security-boundary product** (PARKING_LOT, from the
  2026-08-22 reframe). The recommended cheaper path is *constrained declarative* checks — JSON
  Schema, regex, JSONPath, CEL or JSONLogic — not arbitrary code. Either way it is a
  STACK_DECISIONS row and needs an ADR before anything is built.
- **`console-dashboard` is PAUSED in Phase A** (`mockups/BRIEF.md`), and taxonomy, alignment and
  the disagreement view have no drawn vocabulary. Phase 7's Annotations section was built without
  mockups *because the console's vocabulary was already fixed*; that argument does not transfer
  to a disagreement view, which is a new kind of screen (ADR-0071's reasoning).
- **Two surfaces do not borrow** (PRODUCT 5.5), now asserted in `architecture.test.ts`.

## The three findings that shape the milestone

1. **There is no input.** One annotation exists across every org and it has no note. M5 built the
   loop and nobody has run it — BUILD_SPINE's M5 demo moment ("annotate 20 real traces in under
   five minutes on camera") has not happened, and ADR-0034 reopened *what* the dogfooding tenant
   should judge without closing it. Axial coding over zero notes is not a plan, it is a blocked task.

2. **ADR-0032 and ADR-0033 are accepted and unbuilt, and M6 cannot proceed without them.** An
   alignment session "ends by revising the rubric"; there is no rubric field. A taxonomy-derived
   judge is "configuration generated from taxonomy + rubric"; there is one `question` string.
   Worse, the envelope every judge silently inherits lives in the provider adapter, so no `jdv_`
   records what was actually sent. **Injection fencing belongs in the same work** — the user
   message today interpolates `renderForModel(input/output/reference)` straight after
   `Question:`, with no delimiter and no instruction to ignore embedded directives, and M6 owes
   adversarial cases proving resistance. Note ADR-0033 predates ADR-0073 and still describes its
   slots as `artifact` and `context`; it needs amending to the four roles as it is implemented.

3. **The human label is not per-judge, and alignment needs it to be.** An annotation is
   `acceptable | not_acceptable | skipped` about the whole output. A judge answers one category.
   Kappa per judge therefore requires a per-category human label, and the only thing that can
   produce one is the axial coding step itself: a note assigned to category C is evidence that
   trace T exhibits C. That makes taxonomy assignment the *join* between annotation and judge,
   not merely a naming exercise — and it means the labeled set an alignment session runs against
   is derived from coded notes, with its own version (ADR-0003) so "held-out" is reconstructable.
   **This is the deepest modelling decision in M6 and every agreement number depends on it.**

## Open questions for the human

1. **When does the annotation pass happen, and on what?** M6 has no raw material until it does.
   This is also M5's uncaptured demo moment and ADR-0034's reopened question about what the
   dogfooding tenant judges. Is this a session of your own before M6 planning starts, or does
   M6's first plan include generating the traces and running the pass?
2. **`code` judges: declarative checks, or cut from M6?** Triage is half the value of axial
   coding, and today `code` is a column with a stub behind it. Options: (a) constrained
   declarative checks (JSON Schema / regex / JSONPath / CEL / JSONLogic) — PARKING_LOT's own
   recommendation, no sandbox, a STACK_DECISIONS row and an ADR; (b) defer `code` entirely to M7
   and let the taxonomy record the triage tag without executing it; (c) full sandbox, which is a
   security-boundary product in its own right. **This is stakeholder-owned** (CONVENTIONS
   "Dependency threshold").
3. **Does the labeled set come from coded notes, as finding 3 assumes?** The alternative is a
   second annotation pass that answers per category once the taxonomy exists — more expensive,
   but it produces labels for categories a trace does *not* exhibit, which coded notes cannot
   (a note says what went wrong, never what did not). Kappa needs both classes. **This may be the
   single most consequential answer in the milestone.**
4. **Does the eval suite in CI make real provider calls?** The demo moment is "open a PR that
   worsens the prompt; CI blocks it with eval diffs". Real calls cost money per PR and make the
   gate flaky; recorded fixtures make it deterministic but stop it catching model drift. A
   split — fixtures on every PR, real calls nightly — is a third option with its own ADR.
5. **Does Phase A resume for the disagreement view?** It is the working surface of alignment and
   has no drawn vocabulary, which is ADR-0071's exact criterion. `console-dashboard` is paused
   and would unpause with it.
6. **Should M6 be one plan?** It is six deliverables — taxonomy, triage, judge authoring,
   alignment sessions, the CI gate, the dashboard — against an input that does not exist. M5
   needed two plans and a mid-course correction for less.

## Recommended approach

**Split M6 into at least three plans, and do the prerequisite first.**

- **Prerequisite (not a plan): run an annotation pass.** Real traces on the dogfooding tenant,
  20+ notes. Nothing downstream is designable without seeing what real notes look like — the
  taxonomy's shape, whether 280 characters was right, and whether categories are separable at all.
- **Plan 1 — the authored prompt (ADR-0032 + ADR-0033 + fencing).** The smallest coherent slice,
  it is owed regardless of what M6 decides, and it unblocks both judge authoring and alignment.
  Migration adds `prompt` jsonb and `template`; the envelope moves out of the adapter into a
  versioned compiler; fencing and adversarial cases land with it. Amend ADR-0033 for ADR-0073's
  four roles as part of it.
- **Plan 2 — taxonomy and triage.** `tax_` tables, the axial-coding script (a script plus human
  confirmation, per BUILD_SPINE's "not now" on clustering UI), the category↔note join that
  produces per-judge labels, and judge authoring from a confirmed category — which is where
  ADR-0061's schema-enforced provenance gate lands.
- **Plan 3 — alignment, agreement and the gate.** Sessions as versioned records, the
  disagreement view, kappa with per-class precision/recall and sample size, the judge-disagreement
  sampler as a fifth picker, and the CI job.

Take open questions 2 and 3 before Plan 2 is written; question 1 before anything.
