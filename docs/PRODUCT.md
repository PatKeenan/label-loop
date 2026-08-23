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
- Guest-expert access: orgs invite external experts with time-boxed, panel-scoped access, full audit logging, and configurable data visibility (e.g., PII masking on traces).
- Full tenant data isolation.

### 5.2 Panel & judge management
- CRUD for panels and for the judges inside them. A judge is one binary question; a multi-class label set is modelled as N judges, and the caller applies whatever policy they want across the results.
- Judge type: `llm` or `code`. Code judges are deterministic checks (schema assertion, regex) with near-zero cost and latency and nothing to align.
- **Judge polarity, set per judge and three-valued:** answering `true` either passes, fails, or does not score. `is-missing-repro: true` is a failure; `on-brand: true` is a success; `is-bug: true` is a label with no valence and is excluded from the score entirely. A triage panel is mostly informational judges plus a gate or two; a taste panel is mostly scoring ones. Without polarity the panel score is uncomputable.
- Per-judge weight and the panel's pass threshold, both configured by the customer — we never decide a caller's risk tolerance.
- Model selection per panel or per judge, and prompt/config versioning (`pnv_`, `jdv_`).

### 5.3 Evaluation API
- `POST /v1/panels/{panel_id}/evaluate` — send an artifact plus any context the judges need; receive a decision at the top (`passed`, `score`, `threshold`) and one verdict per judge underneath, each with its reasoning. Reasoning is generated *before* the verdict, always.
- **Both halves are deliberate.** A deterministic workflow step reads `passed` and moves on; an agent deciding what to do next reads the per-judge reasoning, because "which judge failed and why" is the part it can act on. Weights and the threshold are panel configuration; each verdict publishes its normalised weight so a caller can recompute the score rather than trust it.
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

### 5.11 Billing
- Stripe integration: metered usage (per judgment), subscription tier for fine-tuning access, invoices, usage caps.
- *Open, parked (ADR-0019):* enterprises frequently need judge calls routed to their own Bedrock or enterprise endpoint. That removes the model route as a billable surface and takes the SME surcharge with it, so pricing cannot assume a margin on tokens.

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
