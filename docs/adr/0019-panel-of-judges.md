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
- **Whether a panel returns an overall verdict** or only the per-judge set. Leaning
  per-judge only, with an optional caller-configured policy, so LabelLoop never decides
  someone else's risk tolerance.
- **How a skipped judge is represented** once per-judge sampling exists. It must be
  distinguishable from a pass; returning "passed" for a judge that never ran is a lie the
  caller will act on.

Provenance: `thoughts/shared/research/2026-08-22_judge-as-a-service-reframe.md`.
