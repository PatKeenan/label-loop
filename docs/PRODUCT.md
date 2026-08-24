# Product Document — LabelLoop (working title)

**Version:** 0.2 · **Status:** Draft · **Owner:** [You] · **Last updated:** 2026-08-22

> Source of truth for *what* we are building. For *why* each feature exists relative to stakeholder goals, see `STAKEHOLDER_VALUE.md`.

---

## 1. One-liner

**Judge-as-a-service with a built-in eval-to-fine-tune flywheel:** teams create a *panel of judges* that an expert's judgment is distilled into, call it as one step inside their own agentic workflow, annotate real traffic, align each judge against that expert, and graduate to a cheaper fine-tuned open-weights judge served from the same endpoint.

> **Positioning, stated once so nothing downstream drifts (ADR-0019).** We are **one call inside someone else's loop**, not an orchestration layer. Their agent generates the artifact; we judge it. We *are* the inference path for the judge calls — the customer picks the model, we route it — which is what lets us capture every trace server-side and swap the model out later without them changing a line. Classification is not a separate mode: a label set is expressed as N binary judges, so bug triage and taste validation are the same operation performed on artifacts from different sources.

## 2. Problem

Teams bolt LLM judgment onto agentic and automated workflows — bug triage, ticket routing, content labeling, brand and quality gates on generated assets — with no systematic way to know if it's working, improve it, or reduce its cost. Evaluation, annotation, judge alignment, and fine-tuning are scattered across ad-hoc scripts and notebooks. There is no single product that takes a team from "first judgment call" to "owned fine-tuned judge" on one continuous data loop.

**And the human half is worse than the tooling half.** Aligning a judge requires a subject-matter expert, and the industry has no good surface for one: developers hand-roll throwaway annotation UIs, the expert's experience is miserable, and the expertise never accumulates into anything reusable. **That gap is the wedge** — LabelLoop is the one place a developer and an expert meet over a shared data model, each getting a surface built for them.

**Regulatory tailwind:** UK (UK GDPR + DUAA 2025 automated-decision safeguards, ICO AI code of practice) and EU (AI Act logging and human-oversight obligations) regimes are converging on one operational demand — an audit trail proving what an AI system did, why, and who oversaw it. This platform's trace capture, human annotation, and versioned model lineage are precisely that infrastructure; tenants get regulator-ready evidence as a byproduct of the loop.

## 3. Target user

Small-to-mid engineering teams embedding judgment into agentic or automated systems, with at least one subject-matter expert (SME) willing to annotate. Two running personas:

- **Triage.** A platform team judging incoming GitHub issues with a panel — `is-bug`, `is-feature`, `is-question`, `needs-human` — consumed by their triage bot.
- **Taste.** A marketing team gating generated assets on a designer's judgment — `on-brand`, `composition-acceptable`, `colour-balanced` — called from inside their generation agent before an asset ships.

Both send an artifact and receive per-judge verdicts. The only difference is where the artifact came from, which is not a property of our system.

## 4. Core product loop

1. **Create panel** — Team defines a panel in the UI: name, description, the artifact it judges, and its first judges. A judge is one binary question with a definition and optional few-shot examples. A label set becomes N judges, not one multi-class call.
2. **Choose the model** — Team selects which model their judges run on, globally or per judge. We route those calls, which is what makes trace capture and later model-swapping ours to do.
3. **Get scoped token** — Team receives an API key scoped to that panel, and calls it as one step inside their own workflow.
4. **Judge + trace** — Every call runs each judge independently and is fully traced: artifact, per-judge verdict and reasoning, latency, tokens, cost, model version. Judges are never bundled into one prompt — a bundled verdict cannot be attributed, measured, or paid against.
5. **Annotate (open coding)** — SMEs review traces in a surface built for them: agree/correct each verdict, add free-text failure notes. Deliberately taxonomy-blind on the first pass, because showing categories up front anchors the expert and caps the taxonomy at whatever was already imagined.
6. **Axial coding** — The platform assists in clustering free-text notes into a versioned failure taxonomy (programmatic clustering + LLM-assisted theming, human-confirmed). **This step is triage, not just grouping:** each category is tagged as a deterministic `code` check or an `llm` judge, which is why an engineer belongs on this screen alongside the expert.
7. **Judge alignment** — Each category's judge is configured from the taxonomy + rubric and versioned. Judge-vs-human agreement is tracked per judge against a held-out set; drift is surfaced. Later annotation passes label *against* the taxonomy, since per-category labels are what make agreement measurable — with a free-text escape hatch so new failure modes can still emerge.
8. **Fine-tune unlock** — When annotation volume and agreement cross thresholds, the team can launch a fine-tuning job: pick an open-weights base, train a LoRA on annotated data. **The target is the judges** — distilling several expensive frontier judges into one cheap model that reproduces the expert's verdicts.
9. **Dual serving** — The same endpoint can serve frontier judges, fine-tuned judges, or both (shadow mode). Dashboard shows side-by-side agreement and cost.
10. **Graduate** — Team flips routing to the fine-tune, optionally downloads the adapter weights.

## 5. Feature set (V1)

### 5.1 Tenancy, auth & access
- Organization accounts with OAuth/OIDC login; roles: admin, engineer, annotator, guest expert.
- Role-adaptive UI: role determines the surface a user lands on, not just permissions (see 5.5).
- Scoped API keys per panel; key rotation and revocation.
- **Key scopes, not one flat key.** An evaluation key must not be able to rewrite the panel that judges the traffic — that is a privilege-escalation path straight through the product. Minimum split: `evaluate` (call panels and judges), `read` (pull traces and annotations, the documented exit route), `manage` (mutate panel and judge configuration). ADR-0003 defined keys as per-panel with their own quotas but said nothing about scopes; this needs an ADR amendment before the management API ships. Distinct from CONVENTIONS' rule that API keys never grant *console* access, which still holds.
- Guest-expert access: orgs invite external experts with time-boxed, panel-scoped access, full audit logging, and configurable data visibility (e.g., PII masking on traces).
- Full tenant data isolation.

### 5.2 Panel & judge management
- CRUD for panels and for the judges inside them. A judge is one binary question; a multi-class label set is modelled as N judges, and the caller applies whatever policy they want across the results.
- Judge type: `llm` or `code`. Code judges are deterministic checks (schema assertion, regex) with near-zero cost and latency and nothing to align.
- **Judge polarity, set per judge and three-valued:** answering `true` either passes, fails, or does not score. `is-missing-repro: true` is a failure; `on-brand: true` is a success; `is-bug: true` is a label with no valence and is excluded from the score entirely. A triage panel is mostly informational judges plus a gate or two; a taste panel is mostly scoring ones. Without polarity the panel score is uncomputable.
- Per-judge weight and the panel's pass threshold, both configured by the customer — we never decide a caller's risk tolerance.
- **Failure tolerance, configured per panel.** Real fan-outs partially fail, so the customer declares what is acceptable rather than us guessing: which judges are `required` (a `skipped`, `failed` or `error` on one fails the panel outright, whatever the score says) and which may drop out silently. Everything else is best-effort, and the result is returned marked `complete: false`. Deliberately two dials and not ten — the UX cost of a settings matrix is real, and most tenants should never leave the defaults (all judges best-effort, nothing required).
- Configuration is available in the console **and** over a management API, so a team can keep panels in version control rather than clicking. That needs **scoped keys** — see 5.1.
- Model selection per panel or per judge, and prompt/config versioning (`pnv_`, `jdv_`).

### 5.3 Evaluation API
- `POST /v1/panels/{panel_id}/evaluate` — send an artifact plus any context the judges need; receive a decision at the top (`passed`, `score`, `threshold`) and one verdict per judge underneath, each with its reasoning. Reasoning is generated *before* the verdict, always.
- **Both halves are deliberate.** A deterministic workflow step reads `passed` and moves on; an agent deciding what to do next reads the per-judge detail, because "which judge failed and why" is the part it can act on. Weights and the threshold are panel configuration; each verdict publishes its normalised weight so a caller can recompute the score rather than trust it.
- **Verdicts carry taxonomy codes, not just prose.** `reasons[]` comes from the panel's versioned failure taxonomy, so an agent can map a failure to a remediation instead of parsing a sentence — this is what makes a propose → judge → revise loop directed rather than random. A one-line `rationale` carries the human explanation, deliberately capped, because every character lands in the caller's context window.
- Each verdict also reports `confidence` (which drives low-confidence sampling in 5.5), `served_by` — `frontier:sonnet` or `finetune:acme-tone-v3`, so graduation is visible in every payload — plus `latency_ms` and `attempts`.
- Aggregation is one mechanism, `weighted_threshold`, with named presets in the console: *unanimous* is a threshold of 1, *quorum(n)* is equal weights, *veto* is a required judge. Every response echoes `aggregation { policy, panel_version }` so the decision is auditable without a config lookup.
- A judge's raw `verdict` is not the same as `passed` — `is-missing-repro: true` is a failure, `on-brand: true` is a success — so each judge declares which answer counts as a pass, and both fields are returned.
- `POST /v1/judges/{judge_id}/evaluate` — call a single judge directly, so a developer can run exactly the check they need at exactly the point they need it. The panel is a convenience over this primitive, not the only door.
- We never generate the artifact. The caller's agent does that and hands us the result, along with whatever context the judges require.
- Routing flag per judge: `frontier | finetune | shadow` (shadow runs both, returns the selected one).
- Rate limiting, retries with backoff+jitter guidance in client docs, circuit breaking on upstream providers.

### 5.4 Tracing & observability (user-facing)
- Every judge call captured: artifact, verdict, reasoning, model, tokens, cost, latency.
- Trace explorer with filtering (verdict, judge, date, judge-vs-human disagreement).

### 5.5 Annotation
- **Role-adaptive surfaces.** Annotators (typically non-engineer SMEs) land in a minimal, focused flow: one trace at a time, plain-language framing, keyboard/swipe-driven agree/correct + failure notes, a visible session goal (e.g., "12 more today"), no JSON, no navigation sprawl. Engineers land in the dense console (trace explorer, filters, raw payloads). One app, role-based routing. **This is not a UI preference — it is the product** (ADR-0019): the absence of a good expert surface is the gap LabelLoop exists to close.
- **Two annotation modes.** *Open coding* shows a trace and a text box, deliberately without the taxonomy, so the expert notices what is actually wrong instead of sorting into boxes they were handed. *Labeling* shows the taxonomy as structured choices plus a free-text "other", because per-category labels are what make each judge's agreement measurable, and the escape hatch is what keeps new failure modes visible after the taxonomy freezes.
- Sampling strategies: random, low-confidence, judge-disagreement, plus seeded honeypots (gold-standard traces with known labels).
- **Calibrated gamification.** Rewards target accuracy, not volume: honeypot accuracy drives score; points weighted by consensus alignment on multi-annotator items; occasional re-serve consistency checks. Personal streaks/levels by default; competitive leaderboards opt-in per org.
- **Annotator reliability scores** derived from the quality signals above; used to weight labels during fine-tuning dataset curation (Dawid-Skene-style aggregation).
- Annotation coverage and inter-annotator agreement stats.

### 5.6 Axial coding & taxonomy
- Clustering of failure notes with LLM-assisted theme suggestions.
- Human-in-the-loop confirmation to produce a versioned failure taxonomy (`tax_`).
- **Triage as part of the same step:** each confirmed category is tagged `code` or `llm`. "Doesn't match the required structure" becomes a deterministic check; "the composition is unbalanced" becomes an LLM judge. Every category pushed into code is one fewer LLM call in the fan-out.
- Taxonomy size is driven by saturation — when new traces stop producing new categories — not by a fixed cap.

### 5.7 Judges
- One judge per failure category, each a binary question. Never one judge assessing many criteria: a bundled verdict cannot be measured, debugged, or attributed to the expert whose judgment it encodes.
- Judge configuration generated from taxonomy + rubric; versioned (`jdv_`).
- Judges run as **independent calls**. Parallel fan-out costs roughly the latency of one call but N times the tokens, and worsens p99 — a load question for M2, not an assumption.
- **Validation is held-out.** A judge is aligned on one set of human labels and measured on data it was not tuned against; otherwise the agreement number means nothing.
- Metrics reported per judge: per-class precision and recall alongside Cohen's kappa, plus the sample size behind them. Accuracy is never the headline — at 3% prevalence a judge that always says "no" scores 97% — and kappa degrades under exactly the class imbalance rare failure modes live in.
- Online judging of sampled live traffic; judge-vs-human agreement tracked over time with drift alerts.

### 5.7a Alignment sessions
Alignment is a **discrete, repeatable event with its own surface**, not a background number that quietly improves. A session takes one judge, runs it against a labeled set the judge has not seen, shows where it disagrees with the expert, and ends with a decision: accept this version, or revise the rubric and try again.

- Each session is a versioned record — which `jdv_` was tested, against which labeled set, what agreement it achieved, who ran it, what changed as a result. This is what makes "aligned to Sarah's judgment at κ=0.81" a citable claim rather than a slogan, and it is the evidence a contribution ledger would eventually pay against.
- **Re-alignment is expected, not exceptional.** Judgment drifts as products, guidelines and taste change, and models change underneath. A judge's agreement is a claim with a date on it. Drift alerts open a re-alignment session rather than silently degrading.
- The disagreement view is the working surface: the traces where judge and human differ, with the judge's reasoning beside the expert's label, since that is where a rubric gets fixed.
- Sessions are per judge, because agreement is per judge. A panel is not "aligned"; its judges are, each to its own number, each with its own sample size.

### 5.8 Fine-tuning
- Eligibility thresholds (min annotations, min agreement) gate the feature.
- Dataset curation from annotated traces (dedup, split, versioned).
- LoRA training job on a selected open-weights base (one base model family in V1). **The training target is the judges** — one cheap model that reproduces what several expensive frontier judges said, which is in turn what the expert said.
- Automatic post-train eval run against held-out set; results published to dashboard.

### 5.9 Serving fine-tunes
- Inference server with dynamic per-tenant LoRA adapter loading, serving fine-tuned judges.
- Shadow mode for side-by-side comparison before cutover.
- Adapter download for graduated tenants.

### 5.10 Dashboards
- Quality over time: per-judge agreement with the expert, per-taxonomy failure rates, and the sample size behind every number.
- Cost comparison: frontier vs fine-tuned judges, per-call and projected monthly, in dollars.
- **Org-level financial view, with drill-down.** Every service shows spend; this one is two-sided, because an org both consumes and sells. One org-wide screen covering all panels — token usage, spend, revenue from external subscribers, and SME payouts owed — then drill down org → panel → judge → key. Judge-level matters because each judge has its own model and graduates independently, so cost moves per judge rather than per panel; key-level matters because two external clients on the same panel are two separate bills.
- **Three flows, not one.** *Outgoing to us:* judge inference and subscription. *Incoming:* what external consumers pay for this org's panels, net of platform rev-share. *Outgoing to people:* contribution-ledger payouts to the org's own SMEs. A dashboard that shows only the first is the wrong shape for a platform where orgs sell.

### 5.11 Billing
- Stripe integration: metered usage (per judgment), subscription tier for fine-tuning access, invoices, usage caps.
- **Bring-your-own-key is a requirement, not an edge case.** Enterprises will need judge calls routed to their own Bedrock or enterprise endpoint, and refusing that loses the deal. So pricing cannot assume a margin on frontier tokens: for BYOK tenants the frontier phase earns subscription revenue only.
- **The fine-tune is where the economics actually live.** A fine-tuned judge is an artifact the platform created and hosts — trained on the tenant's annotations and their expert's alignment sessions, served from our inference infrastructure. Metered per input and output token, priced by us, with the SME surcharge riding on top. It is defensible rather than extractive: the tenant gets a judge that is faster and cheaper than the frontier calls it replaces, and pays only for the thing we built and run.
- **Two consequences to design for, not defer.** (a) This makes the frontier phase a loss-leader for BYOK tenants, so subscription tiers must carry M1–M7. (b) It needs GPU density: one tenant's LoRA on a dedicated GPU costs more than frontier tokens, and only multi-adapter serving (5.9) makes the margin real — the model has a minimum viable tenant count.
- **Unresolved tension:** 5.9 and the core loop both promise adapter download for graduated tenants, which is incompatible with being the exclusive inference provider for that model. Options include download on a higher tier, download as an exit right that ends the loop, or withdrawing the promise. It is a written commitment today and needs a deliberate answer before M7.

**Pros and cons of hosting the fine-tune as the revenue centre** — recorded now, decided at M7 (see the gate on that milestone in BUILD_SPINE):

| For | Against |
|---|---|
| Charges for an artifact we actually created and run, rather than renting access to someone else's model. Defensible, not extractive. | Ownership of a model trained on the tenant's traffic and their expert's labels is a contractual claim, not a technical one. Enterprise procurement will push on it, and "we host it exclusively" is a much easier position to defend than "we own it". |
| Incentives point the right way: we earn more when the fine-tune is genuinely good, which requires alignment to be real rather than theatrical. | Revenue arrives only at M7. Everything before it is subscription-funded, which is a long runway to price correctly on the first try. |
| Gives the SME royalty a natural funding source — a surcharge on a model that person's judgment trained. | Needs GPU density to clear its cost floor. A single tenant's LoRA on a dedicated GPU is more expensive than frontier tokens; only multi-adapter serving makes it work, so the model has a minimum viable tenant count. |
| Survives BYOK, which subscription-plus-token-margin does not. | Directly contradicts the adapter-download promise above, and portability is precisely what BYOK enterprises care about. |

### 5.12 Governance & audit layer
- **Immutable audit log** of every consequential event — judgment served, annotation made, judge run, prompt/config change, training job, routing cutover, guest-expert data access — with actor, timestamp, and before/after state.
- **Versioning as evidence:** prompts, panels, judges, taxonomies, datasets, and models are versioned such that any past decision can be reconstructed: which model ran, what input it received, what it returned, who reviewed it.
- **Data lifecycle controls:** retention policies, tenant data export/deletion, PII masking on traces.
- **Shared-responsibility model (documented):** tenant prompt/content safety, use-case
  appropriateness, and end-user policy are the tenant's domain. The platform owns its
  own LLM surfaces — judge and clustering prompts are hardened against injection via
  untrusted trace content — plus transport/storage security and access governance.
- **Public `COMPLIANCE_READINESS.md`:** maps implemented controls to SOC 2 Trust Services Criteria, ISO 42001 themes, EU AI Act logging/human-oversight expectations, and UK DUAA (Arts. 22A–22D) automated-decision safeguards. Explicitly framed as readiness and control mapping — never a certification claim.

## 6. Non-goals (V1)

- **Generating anything on the caller's behalf.** Their agent produces the artifact; we judge it. This is the boundary that keeps us a component rather than a competitor to the orchestration layer (ADR-0019).
- Gathering context, calling tools, or orchestrating any part of the caller's workflow.
- Multi-region deployment; bring-your-own-model uploads; on-prem.
- More than one open-weights base family; full-parameter fine-tuning.
- SOC2/compliance certifications (design for it, don't pursue it).
- Expert marketplace (matching, reputation, payouts) — see Future directions; V1 ships guest-expert access only.

## 7. Success metrics (product)

- A tenant can go from signup → first judgment in < 10 minutes.
- End-to-end loop demonstrated by dogfood tenant (this project's own GitHub issues) with ≥ 500 annotated traces.
- Fine-tuned judges within X% of frontier agreement on held-out evals at ≥ 10x lower serving cost (honest number published either way).
- Documented breaking point under k6 load with graceful degradation.

## 8. Dogfooding commitment

The project's own public GitHub repo is tenant #1: incoming issues are judged by a panel (`is-bug`, `is-feature`, `is-question`, `needs-human`) through the production API, annotated by the owner, and carried through the entire loop publicly.

## 9. Architecture sketch (summary)

Web console + annotator surface · typed API gateway · relational database (+ cache if load demands) · async job queue (judging, clustering, training) · frontier provider adapters · open-weights inference server with dynamic LoRA adapter loading · distributed tracing, metrics, and alerting · payments provider (Stripe) · CI/CD with eval regression gates. Concrete technology choices are stakeholder-owned and recorded in `docs/STACK_DECISIONS.md` and ADRs — this document stays implementation-agnostic.

## 10. Future directions (designed for, not built)

- **Contributor revenue share ("annotation royalties").** The grand vision and potential leading differentiator: convert SME annotation from labor that trains one's replacement into an asset that pays ongoing returns. Attribution is deliberately mechanical, not causal: a contributor's share of the reliability-weighted annotations included in a shipped training set. Employer-configurable payout dials on shared metering infrastructure: (a) one-time bounty per accepted annotation, (b) graduation bonus when a fine-tune ships, (c) ongoing royalty as a percentage of metered serving spend on models the contributor's data trained. Dashboard makes it legible: "your annotations = N% of training set; model served X calls this month; your share: $Y." Paired with the oversight framing — UK/EU rules require documented human oversight, so the SME role shifts to overseer of record (judge auditing, escalations, edge cases) rather than disappearing. Staging: design the contribution ledger + attribution schema in V1 data model; ship bounties before royalties. *Open question (parked): whether royalties persist after a contributor leaves the employer.*
- **Expert eval marketplace (V2 horizon).** A two-sided marketplace pairing orgs that can't afford full-time AI staff with independent eval engineers offering human evals, axial coding, and rubric design as a service: matching, reputation scores tied to work quality, and payments handled through the platform (Stripe Connect payouts). V1 deliberately ships only the hardest prerequisite — guest-expert access governance (5.1) — with `expert_profile` and payout schemas sketched in an ADR as evidence of the roadmap.
- **SME expertise-as-a-service (V3 horizon).** The synthesis of the two ideas above. External subject-matter experts (e.g., a designer with recognized taste) register on the platform, build reputation through verified annotation quality, and list themselves as available. A team building a product enlists an expert to seed and steer a panel: the expert's judgment is distilled into labeled data, an aligned panel of judges, and eventually a fine-tune that runs inside the customer's agentic flows — we serve the judgment step, never the whole flow. Compensation is usage-based via the contribution ledger: the more an expert-shaped endpoint is called, the more they earn, and demand raises their premium, expressed as a per-token surcharge on endpoints carrying their contribution. Reputation, attribution, and metering all reuse V1/V2 primitives (reliability scores, contribution ledger, metered billing) — which is what keeps this a roadmap rather than a fantasy.
- Additional open-weights base families; bring-your-own-model.

## 11. Open questions

- Which open-weights base family for V1 (e.g., Llama vs Qwen small models)?
- Judge sampling rate vs cost tradeoff defaults? Related: per-judge sampling means a sampled judge is *monitoring*, not gating, and a skipped judge must be distinguishable from a passing one in the response.
- Where training jobs run (rented GPU vs managed service)?
- Does a panel return an overall verdict, or only the per-judge set? Leaning per-judge only, so we never decide a caller's risk tolerance.
- Is the near-term target a **shared workspace** (a company's own developers and experts) or the **marketplace** (§10)? The workspace is the right first build either way, but the answer changes what M4/M5 must not foreclose.
