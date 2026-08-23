---
date: 2026-08-22T03:10:00Z
author: claude-code
status: resolved
milestone: M0 (what it blocks) · M5–M6 (what it describes)
topic: judge-as-a-service-reframe
related_adrs: [0001, 0003, 0010, 0019]
---

# Judge-as-a-service — positioning, entity model, and the naming it blocks

## Why this doc exists

A conversation on 2026-08-22, at the M0 P2→P3 boundary, triggered by a narrow question —
"is `classifier` the right name for the database?" — that turned out to depend on an
unresolved product framing. The stakeholder had reached the framing in a different chat
that did not carry over.

This is **not codebase research**. It is a framing conversation captured because three of
its consequences land inside M0 and cannot be deferred, while the rest genuinely can.

> **RESOLVED 2026-08-22 → [ADR-0019](../../../docs/adr/0019-panel-of-judges.md).** The
> stakeholder settled the framing at the end of this conversation and asked for it to be
> applied across the project. The object is a **panel** (`pnl_`/`pnv_`) of **judges**
> (`jud_`/`jdv_`); we do not generate the caller's artifact but we *are* the inference path
> for judge calls; classification is expressed as N binary judges. PRODUCT.md,
> CONVENTIONS.md, BUILD_SPINE.md, STAKEHOLDER_VALUE.md, SENIORITY_CHECKLIST.md, README.md,
> ADR-0001, ADR-0003, ADR-0010, ADR-0015, the M0 plan and `packages/contracts` were all
> updated to match. **This document is now history, not instruction — read ADR-0019 for
> the decision.** It is kept because the reasoning, including one wrong turn, is the
> provenance.

The paragraph below described the state before that resolution and is preserved as written:

> Nothing here has been applied to `PRODUCT.md`, `CONVENTIONS.md`, `BUILD_SPINE.md` or any
> ADR. Those are source-of-truth documents; changing them is a stakeholder act.

---

## 1. The reframe

### What LabelLoop is not trying to be
- **Not the orchestration layer.** Asking a team to leave their OpenAI client or agent
  framework is an unwinnable migration. LabelLoop is *one call inside someone else's loop*.
- **Not Langfuse or Braintrust.** But the honest differentiator is *not* "we don't do
  evals" — axial coding, rubrics, judge alignment and agreement tracking are evaluation
  tooling. Those products are general-purpose and developer-only; they assume the human
  judgment already exists and give you somewhere to put it. **LabelLoop is opinionated
  about where the judgment comes from, and owns the expert's experience of producing it.**
  Stated that way, later integration with them is coherent rather than contradictory.

### What it is
A **gate inside an agentic workflow**. The developer assembles the context, calls the
endpoint with the artifact to be judged plus whatever the judge needs to see, and gets back
per-judge verdicts with reasoning. First step, middle step, or last step — the engineer
decides.

The thing being sold is **a specific person's judgment, made callable**: a designer's taste
for generated imagery, a staff engineer's sense of what is genuinely P0 in triage.

### The actual wedge — the two-sided UX
The endpoint is the *collection mechanism*, not the product. The wedge is that the industry
has no good UI for subject-matter experts to align with developers, so developers hand-roll
throwaway annotation UIs and the expertise never accumulates. LabelLoop is the one place
both sides meet over a shared data model:

- **SME surface** — friendly, minimal, non-engineer. Open coding and labeling.
- **Engineer surface** — dense. Axial coding, judge configuration, agreement metrics,
  fine-tune management.

This makes CLAUDE.md's existing "two distinct surfaces" rule *the product*, not a UI
preference. The API-key path out — pull your annotations and do it yourself — is a feature,
because a tool that traps you is a tool engineers distrust.

### Scope boundary, stated hard
LabelLoop does **not** gather context, call tools, or orchestrate. The caller does that and
hands over the result. Refusing this is what keeps LabelLoop a component rather than a
competitor. Model routing runs through us only because being the inference path is the
only way to capture the trace server-side — which is ADR-0001 already, unchanged.

---

## 2. What the conversation settled

### The lifecycle
```
gate/endpoint  →  traces  →  open coding (freeform)  →  axial coding (taxonomy)
                                                              ↓
                                            triage each category: code check | LLM judge
                                                              ↓
                                    one judge per category  →  agreement metrics per judge
                                                              ↓
                                                      fine-tune / model drop
```

### One judge per category, not one judge doing everything
Confirmed as correct and as mainstream practice. A judge asked "does this match the
expected output, and is the quality good, and does it meet brand criteria, and why"
returns one blurry verdict that cannot be measured, debugged or improved. Decomposed
judges each get their own confusion matrix against human labels.

**Consequence: `jud_` is a first-class entity, many-to-one against the endpoint,
independently versioned and independently aligned.**

### The endpoint is NOT a judge — correcting an earlier suggestion in this conversation
Mid-conversation, claude-code proposed *merging* the customer-facing object and the judge
into one entity, on the grounds that the caller experiences the endpoint as a judge.
**That was wrong**, and the one-judge-per-category structure is what disproves it: if a
taxonomy yields six failure modes and each gets its own judge, judges are a *set attached
to* the endpoint and cannot be the same object as it. The existing `jud_` prefix stays
exactly where it is. Recorded because the wrong turn is part of the provenance.

The workable framing is **a gate, with judges behind it**. The gate fans out, collects
every judge's verdict and reasoning, and returns them. It does not have to imply binary:
the caller decides what to do with the results, or an overall pass/fail is derived from a
configurable policy (all must pass / only blocking ones / threshold). That keeps LabelLoop
out of the business of deciding someone else's risk tolerance.

### Judges have a type: `code` vs `llm`
The strongest idea in the conversation. **Not every failure mode needs an LLM judge.**
"Doesn't fit the structure" is a schema assertion; "missing a required field" is a regex.
Deterministic checks have near-zero latency, near-zero cost, and perfect precision and
recall *by construction* — the check does not approximate the definition, it **is** the
definition. There is nothing to align.

This is established practice (prefer a code-based eval wherever the failure mode admits
one), but the product consequence is the interesting part:

> **Axial coding is not just grouping — it is triage.** Each category comes out of that
> step tagged either "deterministic check" or "needs a judge."

And that triage is genuinely a developer's job, because recognising "that is a schema
constraint" requires knowing what is mechanisable — while "the hue is off balance" is
irreducibly the expert's. This is the concrete answer to "who owns the axial-coding
screen": both, for different categories.

It also relieves the latency problem: every category pushed into a code check is one fewer
LLM call in the fan-out.

### Independent calls, decided
Judges run as **separate calls, never bundled into one multi-criteria prompt**. The
stakeholder's reason is stronger than the technical one raised earlier: bundling destroys
the product. If the dashboard is what a company buys, and if the V3 contribution ledger
pays experts based on how their judgment performs, every judge needs its own attributable
score. A bundled call yields one blurred artifact that cannot be decomposed, reported on,
or paid against.

(The technical objection it supersedes: a judge's agreement score is *mode-dependent* —
one measured at 0.85 standalone will not necessarily behave identically bundled with ten
others. Choosing one canonical mode removes the problem rather than managing it.)

### Open coding is taxonomy-blind; the taxonomy appears at axial coding
Confirmed. Showing categories to an expert up front anchors them: they stop noticing what
is wrong and start sorting into the boxes they were given, silently capping the taxonomy at
whatever was already imagined. First pass is a trace and a text box.

**But it is a cycle, not a sequence.** Once a taxonomy stabilises, later annotation passes
*do* label against it — they must, because a judge's precision and recall for "wrong
severity" cannot be computed without human labels that say "wrong severity." Those
structured labels are the judge's validation set. A freeform escape hatch stays alongside
the checkboxes, or the system goes blind to drift and to failure modes that emerge after
the taxonomy froze.

**Consequence — the annotator surface needs two modes:**

| Mode | Expert sees | Produces |
|---|---|---|
| Open coding | Trace + free text | Raw observations → axial-coding input |
| Labeling | Trace + taxonomy + free-text "other" | Per-category labels → judge validation sets |

This is an M5 design consequence, and M5 is the first milestone Phase A says needs a
designed screen.

---

## 3. Methodology grounding

Recorded because the stakeholder explicitly asked to be corrected, and because these
points shape what an honest dashboard may claim.

- **Taxonomy size is data-driven, not capped.** ~7 is a workable heuristic; the real
  stopping rule is saturation — new traces stop producing new categories. Forcing eleven
  genuine failure modes into seven buckets loses signal.
- **TP/FP/TN/FN measure judge *versus human*, not system versus truth.** The judge's job
  is to predict what this expert would have said. That framing is what makes "alignment
  as a service" a measurable claim rather than a slogan.
- **Cohen's kappa has two traps.** It is defined for *two* raters — three SMEs on one
  trace needs Fleiss' kappa or Krippendorff's alpha. And it degrades badly under class
  imbalance (the "kappa paradox"), which is the regime rare failure modes live in: at 3%
  prevalence, a judge that always says "no" scores 97% accuracy and near-zero kappa.
  **Report per-class precision and recall alongside kappa, and never lead with accuracy.**
- **Binary beats a Likert scale.** Humans and models both apply scale points
  inconsistently, so a 1–5 quality score has poor inter-rater reliability and drifts.
  "Did failure mode X occur: yes/no" is far more reliable for both. Get magnitude from the
  *proportion* of traces failing a mode, not from a rating dial. **This answers the earlier
  "pass/fail or a scale?" question in favour of binary.**
- **Reasoning before verdict — and the mechanism matters.** These models are
  autoregressive: each token conditions on those before it. Verdict-first means the reason
  is post-hoc rationalisation and the verdict got no deliberation. Reason-first is
  chain-of-thought and measurably improves judgment accuracy.
  > **Implementation gotcha:** with structured output, **JSON schema key order determines
  > generation order**. It must be `{ "reasoning": …, "verdict": … }`. Getting this
  > backwards silently builds the post-hoc version while looking correct. Worth a test.
- **Judges need held-out validation.** Align on one set, measure on data the judge was not
  tuned against, or the agreement number is meaningless. This is the same hole CLAUDE.md
  already flags as "the absence of any judge-validation metric in PRODUCT 5.7."

---

## 4. Open questions — and exactly what each one blocks

Most of this conversation is deferrable UI and configuration. **Three things are not**, and
the stakeholder's assumption that "the naming is settled" is only half right: the
*structure* is settled, the *central noun* is not.

### Q0 — the question the others depend on, surfaced last and unresolved

**Does LabelLoop run the model that produces the artifact, or only judge an artifact the
caller already produced?**

Both answers appeared in the same conversation. *"The person using us in the UI inputs
which model they want to go to, we capture that because we route them to that model"* is
LabelLoop on the generation path. *"The developers have to send in the generated object
and any other additional context"* is the caller generating and LabelLoop only judging.
PRODUCT.md is unambiguous for the first — "teams create a classification endpoint backed
by a frontier LLM" — while the 2026-08-22 reframe leans on the second.

This is not a naming question, it is an architecture question, and **the noun follows from
it**: judge-only makes `gate` right and `classifier` wrong; running the model makes the
object span classification *and* evaluation.

**claude-code's recommendation: judge-only.** Four reasons.
1. It matches the positioning the stakeholder reached independently — the smallest
   possible ask of a developer, one call inside their own loop.
2. It does not require LabelLoop to be reliable enough to sit on someone's *generation*
   path. A check that is occasionally slow is survivable; a generation dependency that is
   occasionally slow is not.
3. It is **forward-compatible**: judge-only is a strict subset of "both". Generation can be
   added later; it cannot be removed once callers depend on it.
4. **The fine-tune story survives and improves.** If LabelLoop does not generate, the
   fine-tune target moves from the classifier to **the judge** — distilling several
   expensive frontier judges into one cheap aligned model that reproduces the expert's
   verdicts. That is a more direct economic argument for the whole loop than "a cheaper
   classifier", and it makes per-judge alignment metrics load-bearing rather than
   decorative.

**Caveat, and why this is a stakeholder decision rather than an implementation one:** it
contradicts PRODUCT.md as written and re-points ADR-0001, whose rationale is that we
capture traces server-side *because we are the inference path*. Under judge-only we are
still an inference path — the judges are LLM calls through the same `llm/` gateway — but
we no longer see the caller's generation, so "which model produced this" becomes
caller-reported metadata rather than something we control.

### The three that block M0 phases

| # | Question | Blocks | Why it cannot wait |
|---|---|---|---|
| **Q1** | **What is the customer-facing endpoint object called?** *(follows from Q0)* `classifier` (`cls_`/`clv_`) is weak under this framing — in GitHub triage it does triage, for a marketer it gates an asset. `gate` emerged as the working candidate and survives scrutiny. | **P3** (schema, first migration) and hard-blocks **P4** | P3 writes the first forward-only migration; P4 writes `/v1/classify/{id}` and the trace row. CONVENTIONS: a `/v1` shape change means a **new API version**, not an edit. Renaming before anything consumes the API is nearly free; after M1 ships a live URL it is not. |
| **Q2** | **Is the taxonomy/category a first-class entity with its own id prefix?** It sits between annotations and judges, and both hang off it. PRODUCT references "taxonomy + rubric" but it has no prefix in CONVENTIONS' list. | **P3** | It is a table with foreign keys in both directions. Adding it later is a migration through data that already exists. |
| **Q3** | **Does the response contract carry `reasoning` as a first-class field?** Merged P1 contract is `{ label, confidence, trace_id }`. This framing needs verdict + reasoning, per judge. | **P4** | Same `/v1` versioning constraint. Axial coding operates on *why*, so a label-only response starves the loop it exists to feed. |

Softer, but worth deciding alongside Q1: **`classifier_versions` holds the config while
`classifiers` holds only identity.** That is the ordinary resource + immutable version
pattern and is fine, but it means the noun means two things in conversation.

### The scope fork that changes M4/M5
"Connect subject-matter experts with developers in a single spot" reads two ways, and they
are different companies:

- **Shared workspace** — a company's own developers and its own (or invited) experts
  collaborate. This is what the repo builds today and what M4's org/roles work assumes.
- **Marketplace** — experts register, build reputation, get discovered by teams without
  them. PRODUCT.md's V3 horizon. A cold-start problem, not a tooling problem.

The 2026-08-22 language leaned marketplace. If that is the destination, the workspace is
still the right first build — but it changes what M4 and M5 must not foreclose, especially
identity and the contribution ledger.

---

## 5. Deferred by agreement — revisit when the milestone arrives

Recorded so it is not rediscovered from scratch. All of this is configuration and UI, and
the stakeholder is right that it can be tweaked later.

### Execution model (M2 informs it, M5–M6 builds it)
- **Configurable fan-out** is the chosen direction: the developer controls how many judges
  exist and how much traffic each sees. LabelLoop does not impose a cap; if judge count
  hurts the caller's latency, reducing it is the caller's lever.
- **Per-judge traffic sampling** — a regulatory judge at 100%, an aesthetic judge at 10%.
  Sensible economics, since judges are not equal.
- **Unresolved inside this idea:** sampling silently merges two behaviours. A judge that
  always runs is a *gate*; a sampled judge is *monitoring* and has no opinion 90% of the
  time. The response contract must distinguish `skipped` from `passed` — returning
  "passed" for a judge that never ran is a lie the caller will act on. Suggested
  resolution: **blocking judges run at 100% by definition; sampling is available only to
  non-blocking ones.**
- **Sample deterministically** (hash the input to select the judge set) rather than
  randomly, so the same input always gets the same judges. Random sampling produces "it
  passed yesterday and failed today" with no explanation, and makes the system untestable.
- **Flat percentages undersample what matters.** Random 10% oversamples the common case
  and misses rare failures. PRODUCT already has smarter annotation-sampling strategies
  (low-confidence, disagreement, honeypots); reusing them beats inventing a second concept.
- **Parallelism corrections:** 11 parallel calls ≈ the latency of one, but cost is 11×,
  and p99 is *worse* than a single call because the gate waits for the slowest. A k6
  question at M2, and BREAKING_POINT.md's job to answer honestly.
- **Offline and online both supported** — run against historical traces or live traffic.
  Direction agreed; not scoped.

### Dashboard honesty
A judge sampled at 10% has far fewer labeled traces behind its agreement number. **Show
*n* and uncertainty, not just a point estimate** — a kappa of 0.85 over 30 traces and one
over 3,000 are not the same claim. Displaying them identically is the
impressive-over-honest failure CLAUDE.md rules out.

### Market observation
Long-running agentic workflows are increasingly latency-tolerant, which favours the inline
gate; fast workflows currently produce results that are hard to evaluate. Worth revisiting
with real k6 numbers at M2 rather than deciding on intuition now.

---

## 6. Items sent to the parking lot

- **Hosted execution of deterministic checks** (sandbox) — see `docs/PARKING_LOT.md`.
- **AI-authored deterministic checks** — see `docs/PARKING_LOT.md`.
- **Rubric-driven auto-optimisation of prompts** — see `docs/PARKING_LOT.md`.

## 7. Next step

**Q0 is the one to answer first — Q1 is downstream of it.** The three blocking questions in
§4 need stakeholder decisions before P4, and Q1/Q2 before P3 writes the migration.

**Decision taken 2026-08-22:** the noun is **deferred** and P3 proceeds on the existing
`cls_`/`clv_` names. Rationale: renaming a table before anything consumes the API is cheap,
and a public-contract noun should not be settled at the end of a long conversation. The
cost is one small migration later; the cost of guessing wrong is an API version. P3 can proceed on current names without regret — a table rename
before anything consumes the API is cheap — but **P4 is the real gate**.

When decided, the outputs belong in: a PRODUCT.md revision (framing), a CONVENTIONS.md
edit (id prefix list), and an ADR for the endpoint noun, since it is a public contract
decision with a versioning cost.

---

## 8. Follow-on decisions, same day (after ADR-0019 landed)

- **The response carries both a decision and its reasoning** — `passed`, `score`,
  `threshold`, `complete`, then per-judge verdicts. A deterministic step reads the
  summary; an agent reads the reasoning, because "which judge failed and why" is the only
  part it can act on.
- **Judge polarity is three-valued** — answering `true` passes, fails, or does not score.
  `is-bug: true` is a label with no valence, and folding labels into a pass/fail score is
  meaningless. This is what lets a triage panel and a taste panel be the same object.
- **A judge that did not answer says so** — `status: evaluated | skipped | failed`, with
  a partial panel marked `complete: false` rather than silently scored over a smaller
  denominator.
- **Alignment sessions are a first-class product surface** (PRODUCT 5.7a, BUILD_SPINE M6),
  not a background metric: a discrete versioned run against a held-out set, ending in
  accept-or-revise, with re-alignment expected as judgment and models drift.
- **BYOK is a requirement and the fine-tune is where the margin lives.** Enterprises will
  route judge calls to their own Bedrock; the frontier phase then earns subscription
  revenue only, and metered inference on the fine-tuned judge we built and host is the
  durable business. **Unresolved:** PRODUCT still promises adapter download, which is
  incompatible with being that model's exclusive inference provider.
- **Durable execution for the fan-out** (Temporal / Inngest) parked to `PARKING_LOT.md`
  with its failure-mode questions written out.
