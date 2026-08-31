---
date: 2026-08-30T14:53:28Z
author: claude-code
status: draft
milestone: M4
topic: genesis-docs-reconciliation
related_adrs: [0001, 0003, 0019, 0021, 0022, 0025]
---

# Research — the genesis docs against ADR-0019, and where judge prompts are versioned

## Problem summary

ADR-0019 (2026-08-22) redefined what the product IS, and the commit that landed it
(`20e0eec`) reconciled PRODUCT.md thoroughly, BUILD_SPINE and CONVENTIONS partially, and
SENIORITY_CHECKLIST and STAKEHOLDER_VALUE **almost not at all** — its edits to those two
are a noun swap (`classifier`→`judge`, `per-class`→`per-judge`) with no claim
re-derived. Pre-reframe assertions therefore survive in the two documents that define what
this project claims to prove and why each feature exists. Separately and more urgently:
PRODUCT.md promises a judge carries a *question, a definition, optional few-shot examples*
and a *rubric*, all versioned on the `jdv_`; the schema has **one** field (`question`), the
rest of the prompt is a hardcoded literal in the adapter, and **M4 — the milestone that
builds the judge wizard and publishes the SDK — does not mention authoring any of it.**

## The evidence: what the reframe actually touched

`git blame` against the genesis commit (`c27a2be`, 2026-08-20) and the reframe commit
(`20e0eec feat(contracts)!: replace the classifier with a panel of judges`):

| Document | Lines still at genesis | Touched by the reframe | Total |
|---|---|---|---|
| PRODUCT.md | 90 | **93** | 190 |
| BUILD_SPINE.md | 99 | 37 | 177 |
| CONVENTIONS.md | 137 | 34 | 186 |
| SENIORITY_CHECKLIST.md | 75 | **5** | 92 |
| STAKEHOLDER_VALUE.md | 107 | **4** | 111 |

The five SENIORITY_CHECKLIST edits and the four STAKEHOLDER_VALUE edits are reproducible
with `git blame <file> | grep '^20e0eec'`. Every one is a vocabulary substitution. None
re-examines whether the claim on that line is still the claim the product makes.

The sharpest single instance: the reframe **edited** STAKEHOLDER_VALUE's row
*"Structured-output evaluation API w/ streaming"* — changing `per-class verdicts` to
`per-judge verdicts` on that exact line — and left `w/ streaming` untouched. The editor's
attention was on the line and changed only the noun.

## Confirmed contradictions

1. **Streaming is claimed in two docs and ruled out by an approved plan.**
   SENIORITY_CHECKLIST §1 *"Streaming + structured outputs with confidence — M1 · API
   contract"* and STAKEHOLDER_VALUE *"Structured-output evaluation API w/ streaming"* vs
   `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` → **Explicitly NOT
   doing: "Streaming, in all three of its senses (D5)"**, with the reasoning that
   `aggregate()` normalises weights across the judges that actually scored, so there is no
   correct partial `Evaluation`. M1 is nearly shipped. Two public scoreboards still claim
   the feature.

2. **M6's demo moment demos the wrong actor on the wrong surface.**
   BUILD_SPINE.md:123 — *"open a PR that worsens the prompt; CI blocks it with eval
   diffs"* — is a genesis line the reframe did not touch (it touched line 122, directly
   above it). For a product whose thesis is that an SME configures and versions judges in a
   UI without an engineer, the highlight-reel moment shows an engineer editing a prompt in
   code with CI as the gate. It is also the **only** statement anywhere in the docs that
   implies judge prompts live in code, which is what makes CONVENTIONS.md:124 (*"Prompts
   live in versioned judge configs, not in code"*) read as self-contradictory.
   **Note the split:** the underlying competency claim is legitimate and deliberate —
   STAKEHOLDER_VALUE:42 gives the reason as *"Shows evals as engineering infrastructure
   (regression gates), not notebooks"*, i.e. it is a proof aimed at an interviewer about
   **our own** repo's CI, not a product feature. What is wrong is its promotion to the
   product's demo moment, not its existence as an internal practice.

3. **BUILD_SPINE.md:46 still says "Classifier + version rows"** — the last surviving
   `classif*` token in `docs/`, in M1, which is the milestone now shipping.

## The prompt-versioning gap (the load-bearing one)

**What PRODUCT.md promises**

- :34 — *"A judge is one binary question **with a definition and optional few-shot
  examples**."*
- :96 — *"Judge configuration generated from taxonomy + **rubric**; versioned (`jdv_`)."*
- :103 — an alignment session *"ends with a decision: accept this version, or **revise the
  rubric** and try again."*
- :145 — versioning such that any past decision is reconstructable: *"which model ran,
  **what input it received**, what it returned."*

**What exists**

- `packages/db/src/schema/judge-versions.ts:56` — `question`, one text column. That is the
  entire authored prompt surface. No `definition`, no `examples`, no `rubric`.
- `apps/api/src/llm/openrouter-provider.ts:83` (`messages()`) — the system message is a
  hardcoded literal, **identical for every judge and versioned by nothing**. Its own
  docstring names the hazard exactly: *"Anything more opinionated would be an unversioned
  prompt fragment that every `jdv_` silently inherits and no version records"* — and
  justifies itself on the premise *"The judge's rubric IS `question`."*
- `packages/db/src/schema/trace-verdicts.ts` — stores `raw_response` only. There is no
  `raw_request` or prompt-version column, so PRODUCT.md:145's *"what input it received"* is
  not reconstructable from a trace; the question and artifact are recoverable, the envelope
  and output schema are whatever the code said that day.

**Why the M0 premise expires at M6.** BUILD_SPINE M6 requires *"Judges configured from
taxonomy + rubric"*, alignment sessions *"ending in accept-or-revise"*, and *"Judge prompts
fence untrusted trace content"*. Fencing is a change to `messages()` — that is, to the
code-resident envelope that the docstring above warns becomes an unversioned fragment every
`jdv_` inherits. So M6 simultaneously requires editing the envelope and depends on the
envelope not moving under frozen versions.

**The measurement consequence, which is the serious one.** M6's console promises
*"agreement by judge version"* and SENIORITY_CHECKLIST §2 promises *"Agreement dashboards
over time, pinned to judge versions"*. If two `jdv_` rows can be byte-identical and behave
differently because the harness moved beneath them, then the identifier those dashboards
are pinned to does not determine behaviour, and the agreement timeline silently spans
configuration changes — the exact failure `aggregation { panel_version }` was added to
ADR-0019 to prevent for panels.

### Does M4 cover it? No.

BUILD_SPINE M4 reads: *"create panel and judges (wizard → immutable version 1), issue/revoke
keys, raw trace table"*, and then spends its entire remaining body on the capability-gated
model picker (deferred from M1 by ADR-0021). The authoring surface for the judge's prompt
is implied by the single word *"wizard"* and specified nowhere. M4 also **publishes the thin
client SDK**, generated from contracts.

**This is why M4 is the deadline rather than M6.** Adding a column later is an ordinary
forward-only migration (ADR-0006) and costs little. What is not cheap is that M4 freezes the
*shape* of a judge into three public surfaces at once — the wizard UI, the contracts
package, and a published SDK — and CONVENTIONS makes a `/v1` change a new API version rather
than an edit. Deciding "a judge is one question" versus "a judge is a question plus a
definition, examples and a rubric" after M4 is a breaking change to a contract we committed
to version rather than mutate.

## Relevant files

- `docs/adr/0019-panel-of-judges.md` — defines what the product is; the baseline everything
  here is measured against. Amends ADR-0001 and ADR-0003.
- `docs/BUILD_SPINE.md` — the single ordering authority. M4:87-101 (wizard + SDK, no
  authoring), M6:112-125 (rubric, alignment sessions, fencing, the PR demo moment), M1:46
  (stale `Classifier` token).
- `docs/SENIORITY_CHECKLIST.md` / `docs/STAKEHOLDER_VALUE.md` — 96% pre-reframe; the two
  scoreboards an interviewer reads.
- `packages/db/src/schema/judge-versions.ts` — the frozen row; `question` is the whole
  authored prompt today, and ADR-0003 freezes whatever shape M4 ships.
- `apps/api/src/llm/openrouter-provider.ts:74-104` — `messages()`, the unversioned envelope,
  with a docstring that already states the constraint being broken.
- `packages/db/src/schema/trace-verdicts.ts` — `raw_response` only; nothing identifies the
  harness that produced the verdict.
- `packages/contracts/src/evaluate.ts` — `judgeOutputSchema` and `RATIONALE_MAX_LENGTH`;
  the output half of the same "what was actually sent" question.
- `thoughts/shared/research/2026-08-23_cross-thread-reconciliation.md` — a prior
  reconciliation pass; worth reading before planning to see what it already settled and to
  understand why these two docs were missed.

## Constraints that apply

- **ADR-0003 / CONVENTIONS "Data rules"** — `jdv_` is immutable; editing creates version
  n+1. Whatever fields exist are frozen per version, and whatever fields do *not* exist
  cannot be revised by an alignment session.
- **ADR-0019** — one judge per failure category, never one judge doing many things; judges
  are never bundled into a multi-criteria prompt. Any rubric field must not become a licence
  to smuggle several criteria into one judge.
- **CONVENTIONS.md:124** — *"Prompts live in versioned judge configs, not in code."*
  Currently true only of `question`.
- **CONVENTIONS "API rules"** — breaking change = new version, never mutation. This is what
  gives M4 a deadline.
- **CONVENTIONS "Repo shape"** — `packages/contracts` is the single source of type truth; a
  rubric field is a contracts change before it is a schema change.
- **ADR-0022 / ADR-0025** — the precedent for the *shape* of the fix: a frozen version pins
  a capability contract as a concrete literal precisely so its meaning cannot move when
  something upstream changes its default. The unversioned envelope is the same defect with
  a different upstream — us.
- **CLAUDE.md** — BUILD_SPINE is the single ordering authority; work that maps to no
  STAKEHOLDER_VALUE row is scope creep. The rubric work maps to PRODUCT.md:96/:103 and is
  not creep.

## Open questions for the human

1. **What is a judge's authored surface, exactly?** PRODUCT names four things (question,
   definition, few-shot examples, rubric) and the schema has one. Are these four columns,
   one structured `prompt` jsonb, or is "rubric" a synonym for "definition" rather than a
   fifth thing? This is the question M4 freezes.
2. **Where does the split fall between authored config and harness?** Proposal to react to:
   authored (question/definition/examples/rubric) on the `jdv_` and editable in the UI;
   harness (envelope, injection fencing, output schema) in code and PR-reviewed — with the
   harness given a version that is **stamped onto every verdict**, which closes the
   reconstruct-what-was-sent gap and makes agreement-by-version honest. Does that split
   match your intent, or should the envelope also become tenant-editable?
3. **Does the harness version go on `trace_verdicts`, or does the whole rendered prompt?**
   A version pointer is cheap and stable; the rendered prompt is bulky, duplicated per
   verdict, and definitive. PRODUCT.md:145 promises reconstructability but does not say
   which.
4. **M6's demo moment — replace or split?** Proposal: the product demo becomes an SME
   revising a rubric in an alignment session and the session refusing a regression against
   the held-out set; the CI eval gate stays as an internal engineering practice, keeping
   SENIORITY_CHECKLIST §2's competency claim but rewording its artifact (currently
   *"blocked-PR link"*).
5. **Streaming — cut the claim or reinstate the feature?** M1's plan rules it out with
   stated reasoning; two scoreboards still promise it. One of the three has to move.
6. **Does this need one ADR or two?** The authored/harness split and the harness-version
   stamp are separable decisions; the second is a `trace_verdicts` change and could ride
   with M3's observability work instead.

## Recommended approach

1. **Answer Q1 and Q2 first** — they are the only ones with a deadline, and everything else
   is downstream of them. Nothing should be planned into M4 until the judge's authored shape
   is settled.
2. **One ADR for the authored/harness split**, with the harness-version stamp recorded as a
   consequence rather than a separate decision, unless Q6 says otherwise. It amends ADR-0003
   (what is versioned) the way ADR-0019 did.
3. **Amend BUILD_SPINE M4** to name the judge authoring surface explicitly alongside the
   model picker, and note the SDK/contract freeze as the reason it belongs there rather than
   at M6. Amend M6's demo moment per Q4.
4. **Sweep the two scoreboards as a single pass**, not opportunistically — SENIORITY_CHECKLIST
   and STAKEHOLDER_VALUE are 96% pre-reframe, so a line-by-line re-derivation against
   ADR-0019 is likely to surface more than the streaming row. Do this as its own small
   commit so the diff is readable as evidence of the reconciliation.
5. **Leave the M1 P5 branch alone until step 1 is answered.** It is unaffected by any of
   this — its open question is the rationale-length blocker, which is independent — but it
   should not absorb doc churn mid-phase.

**Not recommended:** widening M1 to carry any of this. M1 is one phase from done, and its
plan's "Explicitly NOT doing" already names the judge-authoring surface as M4's.
