# ADR-0019: The product is a panel of judges, not a classifier

**Status:** Accepted · **Date:** 2026-08-22
**Amends:** ADR-0001 (what we are the gateway *for*), ADR-0003 (what is versioned)

## Decision

The customer-facing object is a **panel** (`pnl_`), an immutably versioned (`pnv_`) named
set of **judges** (`jud_`). A caller sends an artifact to a panel and receives one verdict
per judge, each with its reasoning.

Four things follow, and they are the decision:

**1. We do not generate the caller's artifact.** Their agent does that, in their
orchestration, using their tools and their context. We are one call inside their loop.
Asking a team to move their generation to us is an unwinnable migration and is not the
product.

**2. We *are* the inference path for judge calls.** The customer configures which model
their judges run on — globally, or per judge — and we route those calls. This is what
preserves ADR-0001: traces are captured server-side because the judge call flows through
us. It is also the mechanism that makes graduation possible, since swapping a judge's
model is a configuration change on our side rather than a change in the customer's code.

**3. Classification is expressed as judgment.** There is no separate "classify" mode. A
label set becomes N binary judges — bug triage is `is-p0`, `is-security`, `is-duplicate`,
`is-missing-repro`, each returning yes/no plus reasoning — rather than one multi-class
call. This is the same reasoning that makes binary judges preferable to a Likert scale:
each verdict is independently measurable against what the expert would have said, so each
is independently alignable, reportable, and payable.

**4. The fine-tune target is the judge, not the classifier.** Graduation means distilling
several expensive frontier judges into one cheap aligned model that reproduces the
expert's verdicts. The economic claim becomes "your judging costs 10x less and still
agrees with Sarah," which is more direct than "a cheaper classifier."

### The response carries both a decision and its reasoning
**Resolved 2026-08-22.** A panel evaluation returns a summary *and* the per-judge detail:
`passed`, `score` (the weighted share of judges that passed, 0–1), `threshold` (the bar
this panel version was configured with, echoed so the decision is auditable from the
response alone), and then one `Verdict` per judge.

Both halves earn their place, and the reason is the caller. A deterministic step in a
workflow reads `passed` and moves on. An **agent** deciding what to do next reads the
verdicts, because "which judge failed and why" is the only part it can act on —
regenerate for this reason, escalate for that one. Returning only the summary makes the
agent case impossible; returning only the detail makes every caller reimplement the same
policy, badly and differently.

Weights and the threshold are panel configuration, set by the customer. Each verdict
publishes its **normalised weight** (weights across a panel sum to 1) so a caller can
recompute the score rather than trust it — which is what a deterministic gate actually
needs. Six equally weighted judges with three passing scores 0.5; against a threshold of
0.7, `passed` is false.

**Judges do not all point the same way, so a verdict is not a pass — and polarity is
three-valued.** `is-missing-repro: true` is a failure. `on-brand: true` is a success.
`is-bug: true` is *neither*: it is a label, and folding a label into a pass/fail score is
meaningless. Summing raw booleans across judges that mean opposite things would be worse
than useless, because it would look like a number.

Every judge therefore declares its own polarity as part of its configuration: answering
`true` passes, fails, or **does not score**. Every `Verdict` carries both `verdict` — the
judge's raw answer, and the field an annotator agrees with or corrects — and `passed`,
that answer under the judge's polarity, which is what the score sums. Informational judges
return `passed: null` and `weight: null` and are absent from **both** the numerator and
the denominator.

The practical consequence is that a panel can mix modes honestly. A triage panel is mostly
informational judges (`is-bug`, `is-feature`, `is-question`) plus perhaps one real gate
(`needs-human`); a taste panel is mostly scoring judges. Both are the same object, and
neither has to pretend to be the other.

### A judge that did not answer says so, and a partial panel is marked
**Resolved 2026-08-22.** Every `Verdict` carries a closed `status`: `evaluated` (it ran
and answered), `skipped` (sampling excluded it), or `failed` (it ran and produced nothing
usable). Skipped and failed are **not** passes, and a caller must never treat them as one
— returning "passed" for a judge that never ran is a lie the caller will act on. They
answer nothing, so `reasoning`, `verdict`, `passed` and `weight` are all null.

`status` also disambiguates the two reasons `passed` can be null, which would otherwise be
indistinguishable: the judge is *informational* and does not score, or it never ran at all.

The panel result carries **`complete`**: true when every scoring judge actually ran. This
is the answer to "eight of eleven succeeded — do we deliver the partial?" **We deliver it
and say so.** Failing the whole call because one judge died throws away eight good
verdicts; returning the partial silently is worse, because `score` would be computed over
a smaller denominator and look exactly like a confident whole-panel number. Marked partial
results let a caller decide — proceed, retry, or escalate — which is the same principle as
not deciding their risk tolerance for them.

### The judge's own output, and where key order actually matters
**Revised 2026-08-23.** A judge is asked for four fields, in this order: `rationale` (one
line, capped, for a human), `reasons` (taxonomy codes), `verdict` (binary), `confidence`
(0–1). Think, categorise, decide, then assess how sure you are.

This is the **only** schema whose property order is load-bearing, and the distinction was
wrong in the first draft of this ADR. The response `Verdict` wraps the judge's output in
metadata *we* compute, so its key order drives nothing; the **structured-output schema for
the judge call** is what determines generation order. `judgeOutputSchema` is therefore a
separate exported schema, with a test on its ordering.

`reasons` as taxonomy codes is the field an agent branches on: prose cannot be acted upon,
a code can be mapped to a remediation. The axial-coded failure taxonomy becomes the
remediation vocabulary, which is what makes a propose→judge→revise loop directed rather
than random.

`confidence` is not a softened verdict — the verdict stays binary. It exists because
PRODUCT 5.5 promises **low-confidence sampling** as an annotation queue, and you cannot
sample by a confidence you do not return.

### Aggregation is one mechanism with presets
**Decided 2026-08-23.** The only policy is `weighted_threshold`, because it already
expresses the named policies people ask for: *unanimous* is a threshold of 1, *quorum(n)*
is equal weights with the threshold set accordingly, and *veto* is a `required` judge that
fails the panel outright whatever the score. Four policies would be four code paths and
four sets of edge cases for one behaviour. The console offers named presets over the single
mechanism.

Short-circuit evaluation is deliberately absent: returning as soon as the verdict is
determined saves latency but loses the sampling data from judges that never ran. Revisit
when M2's load numbers justify the trade, not before.

Every evaluation echoes `aggregation { policy, panel_version }`, pinning the immutable
panel version that produced the decision so a score timeline can never silently span a
configuration change.

### Judges are keyed by slug, not listed
**Decided 2026-08-23.** `judges["is-p0"]`, because the common case is an agent asking about
one specific judge and the slug is the name a developer writes in their code. Ordering and
duplicate judges are not things a panel needs.

Each verdict also carries `served_by` (`frontier:sonnet`, `finetune:acme-tone-v3`), which
puts the graduation story in every payload, plus `latency_ms` — judges fan out in parallel,
so the panel's total is the slowest one, and this is what tells a caller which seat shapes
their p99 — and `attempts`, which surfaces retry flakiness a bare success would hide.

### API shape (proposed; P4 confirms)
- `POST /v1/panels/{panel_id}/evaluate` — run the panel, return every judge's verdict.
- `POST /v1/judges/{judge_id}/evaluate` — run one judge directly.

Per-judge access is deliberate: it lets a developer call exactly the check they need at
exactly the point they need it, and it makes the panel a convenience over a primitive
rather than the only door.

## Context

The repo was built to a "classification-as-a-service" framing: teams create a classifier,
we serve classifications from a frontier model, we judge those classifications, and
eventually a fine-tune replaces the classifier. That framing survived contact with the
first two M0 phases but not with the question of what to call the database tables.

The trigger was narrow — is `classifier` the right name? — but the answer depended on
unresolved positioning. Two framings were in play simultaneously and had never been
reconciled: one where LabelLoop runs the model that produces the output, and one where the
caller produces the output and LabelLoop only judges it. Both appeared in the same
conversation, and PRODUCT.md assumed the first while the working framing assumed the
second.

The reconciliation is that **only the judging is ours**. The caller's generation is not,
and never was, something we could realistically capture without asking them to restructure
their system.

What made the naming hard was that neither candidate covered the product. `classifier` fits
bug triage and fits taste validation badly. `gate` fits taste validation and fits triage
badly — and it also over-promises, since the endpoint returns findings and lets the caller
apply policy rather than deciding anything itself. `panel` covers both because it names the
*structure* (several judges convened over one artifact) rather than the outcome.

The observation that dissolved the difficulty: **triage and taste validation are the same
operation.** Both send an artifact and receive per-category verdicts. The only difference
is where the artifact came from — the caller's agent generated one, a user filed the other
— and that is not a property of our system.

Rejected alternatives:
- **`classifier` (status quo)** — increasingly wrong as the product centres on validating
  artifacts the caller produced, and it implies a single multi-class output when the real
  shape is N independent binary verdicts.
- **`gate`** — the stakeholder's own first instinct and a good one, but it implies a
  blocking binary decision the endpoint does not make, and "run my trace history through
  the gate" is incoherent for the offline case.
- **`evaluator`** — accurate and spans both cases, but "evals" is the home turf of
  Langfuse and Braintrust, and it collides with the M6 eval-suite concept.
- **Merging panel and judge into one entity** — proposed and discarded during the same
  conversation. One judge per failure category means judges are a *set attached to* the
  panel; they cannot be the same object.

## Consequences

- **ADR-0001 is narrowed, not overturned.** We remain the gateway and still capture 100%
  of traffic server-side — but the traffic is judge calls, not the caller's generation.
  "Which model produced the artifact" becomes caller-supplied metadata rather than
  something we control.
- **ADR-0003's immutable versions apply to panels** (`pnv_`) and to judges. Every trace,
  annotation, eval score and dataset row FKs to a judge version.
- **Judges carry a type, `code` or `llm`.** Failure modes that reduce to a schema
  assertion or a regex become deterministic checks with near-zero cost and latency and
  perfect precision by construction. Axial coding therefore becomes *triage* — each
  category is tagged as code or judge — which is why the developer belongs on that screen
  alongside the expert.
- **Judges run as independent calls, never bundled** into one multi-criteria prompt. A
  bundled call cannot be attributed, reported on, or paid against, which breaks both the
  dashboard and the contribution ledger.
- **The taxonomy becomes a first-class entity** (`tax_`): it sits between annotations and
  judges, and both hang off it.
- **The published contract changes shape.** `POST /v1/classify/{classifier_id}` returning
  `{ label, confidence }` is superseded by a panel evaluation returning per-judge verdicts
  with reasoning. This is why the decision had to land before M0-P4 writes the endpoint:
  CONVENTIONS makes a `/v1` change a new API version, not an edit.
- **Reasoning is a first-class response field**, generated *before* the verdict. These
  models are autoregressive, so a verdict emitted first makes its reasoning post-hoc
  rationalisation. With structured output this means schema key order is load-bearing.
- **PRODUCT.md's V1 non-goal "classification only" is retired** in its old sense: we do not
  generate, so the constraint that mattered was never about task type. What remains out of
  scope is generation on the caller's behalf.

## Open questions this does not settle

- **Billing when the customer brings their own provider key.** Enterprises will often need
  routing to their own Bedrock or enterprise endpoint, which removes the model route as a
  billable surface and takes the SME surcharge with it. Parked deliberately; revisit at M8.

Provenance: `thoughts/shared/research/2026-08-22_judge-as-a-service-reframe.md`.
