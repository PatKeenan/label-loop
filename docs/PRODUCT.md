# Product Document — LabelLoop (working title)

**Version:** 0.1 · **Status:** Draft · **Owner:** [You] · **Last updated:** 2026-08-18

> Source of truth for *what* we are building. For *why* each feature exists relative to stakeholder goals, see `STAKEHOLDER_VALUE.md`.

---

## 1. One-liner

Classification-as-a-service with a built-in eval-to-fine-tune flywheel: teams create a classification endpoint backed by a frontier LLM, annotate real traffic, align an automated judge, and graduate to a cheaper fine-tuned open-weights model served from the same endpoint.

## 2. Problem

Teams bolt LLM classification onto internal workflows (bug triage, ticket routing, content labeling) with no systematic way to know if it's working, improve it, or reduce its cost. Evaluation, annotation, judge alignment, and fine-tuning are scattered across ad-hoc scripts and notebooks. There is no single product that takes a team from "first classification call" to "owned fine-tuned model" on one continuous data loop.

**Regulatory tailwind:** UK (UK GDPR + DUAA 2025 automated-decision safeguards, ICO AI code of practice) and EU (AI Act logging and human-oversight obligations) regimes are converging on one operational demand — an audit trail proving what an AI system did, why, and who oversaw it. This platform's trace capture, human annotation, and versioned model lineage are precisely that infrastructure; tenants get regulator-ready evidence as a byproduct of the loop.

## 3. Target user

Small-to-mid engineering teams embedding classification into agentic or automated systems, with at least one subject-matter expert (SME) willing to annotate. Example persona: a platform team classifying incoming GitHub issues/bugs as `bug / feature / question / needs-human`, consumed by their triage bot.

## 4. Core product loop

1. **Create classifier** — Team defines a classifier in the UI: name, description, label set (binary, multi-class, or multi-label), optional label definitions and few-shot examples.
2. **Get scoped token** — Team receives an API key scoped to that classifier, hits a single inference endpoint from their own systems.
3. **Serve + trace** — Every request is served by the selected frontier model and fully traced: input, output, label, confidence, latency, tokens, cost, model version.
4. **Annotate** — SMEs review traces in an annotation UI: agree/correct the label, add free-text failure notes. Inter-annotator workflows for teams with multiple SMEs.
5. **Axial coding** — The platform assists in clustering free-text failure notes into a failure taxonomy (programmatic clustering + LLM-assisted theming, human-confirmed).
6. **Judge alignment** — An LLM judge is configured from the taxonomy + rubric and runs online against live traffic. Judge-vs-human agreement is tracked continuously; drift is surfaced.
7. **Fine-tune unlock** — When annotation volume and judge agreement cross thresholds, the team can launch a fine-tuning job: pick an open-weights base, train a LoRA on annotated data.
8. **Dual serving** — The same endpoint can serve frontier model, fine-tuned model, or both (shadow mode). Dashboard shows side-by-side quality (per judge + human labels) and cost.
9. **Graduate** — Team flips routing to the fine-tune, optionally downloads the adapter weights.

## 5. Feature set (V1)

### 5.1 Tenancy, auth & access
- Organization accounts with OAuth/OIDC login; roles: admin, engineer, annotator, guest expert.
- Role-adaptive UI: role determines the surface a user lands on, not just permissions (see 5.5).
- Scoped API keys per classifier; key rotation and revocation.
- Guest-expert access: orgs invite external experts with time-boxed, classifier-scoped access, full audit logging, and configurable data visibility (e.g., PII masking on traces).
- Full tenant data isolation.

### 5.2 Classifier management
- CRUD for classifiers; label-set types: binary, multi-class, multi-label.
- Model selection (frontier provider) and prompt/config versioning.

### 5.3 Inference API
- Single REST endpoint: `POST /v1/classify/{classifier_id}` returning structured JSON (label(s), confidence, trace_id), with optional streaming.
- Routing flag per classifier: `frontier | finetune | shadow` (shadow runs both, returns the selected one).
- Rate limiting, retries with backoff+jitter guidance in client docs, circuit breaking on upstream providers.

### 5.4 Tracing & observability (user-facing)
- Every call captured: input, output, model, tokens, cost, latency.
- Trace explorer with filtering (label, confidence, date, judge disagreement).

### 5.5 Annotation
- **Role-adaptive surfaces.** Annotators (typically non-engineer SMEs) land in a minimal, focused flow: one trace at a time, plain-language framing, keyboard/swipe-driven agree/correct + failure notes, a visible session goal (e.g., "12 more today"), no JSON, no navigation sprawl. Engineers land in the dense console (trace explorer, filters, raw payloads). One app, role-based routing.
- Sampling strategies: random, low-confidence, judge-disagreement, plus seeded honeypots (gold-standard traces with known labels).
- **Calibrated gamification.** Rewards target accuracy, not volume: honeypot accuracy drives score; points weighted by consensus alignment on multi-annotator items; occasional re-serve consistency checks. Personal streaks/levels by default; competitive leaderboards opt-in per org.
- **Annotator reliability scores** derived from the quality signals above; used to weight labels during fine-tuning dataset curation (Dawid-Skene-style aggregation).
- Annotation coverage and inter-annotator agreement stats.

### 5.6 Axial coding & taxonomy
- Clustering of failure notes with LLM-assisted theme suggestions.
- Human-in-the-loop confirmation to produce a versioned failure taxonomy.

### 5.7 Judge
- Judge configuration generated from taxonomy + rubric; versioned.
- Online judging of sampled live traffic; judge-vs-human agreement tracked over time with drift alerts.

### 5.8 Fine-tuning
- Eligibility thresholds (min annotations, min agreement) gate the feature.
- Dataset curation from annotated traces (dedup, split, versioned).
- LoRA training job on a selected open-weights base (one base model family in V1).
- Automatic post-train eval run against held-out set; results published to dashboard.

### 5.9 Serving fine-tunes
- Inference server with dynamic per-tenant LoRA adapter loading.
- Shadow mode for side-by-side comparison before cutover.
- Adapter download for graduated tenants.

### 5.10 Dashboards
- Quality over time: human-label accuracy, judge scores, agreement, per-taxonomy failure rates.
- Cost comparison: frontier vs fine-tune, per-call and projected monthly, in dollars.

### 5.11 Billing
- Stripe integration: metered usage (per-classification), subscription tier for fine-tuning access, invoices, usage caps.

### 5.12 Governance & audit layer
- **Immutable audit log** of every consequential event — classification served, annotation made, judge run, prompt/config change, training job, routing cutover, guest-expert data access — with actor, timestamp, and before/after state.
- **Versioning as evidence:** prompts, judges, datasets, and models are versioned such that any past decision can be reconstructed: which model ran, what input it received, what it returned, who reviewed it.
- **Data lifecycle controls:** retention policies, tenant data export/deletion, PII masking on traces.
- **Shared-responsibility model (documented):** tenant prompt/content safety, use-case
  appropriateness, and end-user policy are the tenant's domain. The platform owns its
  own LLM surfaces — judge and clustering prompts are hardened against injection via
  untrusted trace content — plus transport/storage security and access governance.
- **Public `COMPLIANCE_READINESS.md`:** maps implemented controls to SOC 2 Trust Services Criteria, ISO 42001 themes, EU AI Act logging/human-oversight expectations, and UK DUAA (Arts. 22A–22D) automated-decision safeguards. Explicitly framed as readiness and control mapping — never a certification claim.

## 6. Non-goals (V1)

- Free-text extraction or generation tasks (classification only).
- Multi-region deployment; bring-your-own-model uploads; on-prem.
- More than one open-weights base family; full-parameter fine-tuning.
- SOC2/compliance certifications (design for it, don't pursue it).
- Expert marketplace (matching, reputation, payouts) — see Future directions; V1 ships guest-expert access only.

## 7. Success metrics (product)

- A tenant can go from signup → first classification in < 10 minutes.
- End-to-end loop demonstrated by dogfood tenant (this project's own GitHub issues) with ≥ 500 annotated traces.
- Fine-tuned model within X% of frontier quality on held-out evals at ≥ 10x lower serving cost (honest number published either way).
- Documented breaking point under k6 load with graceful degradation.

## 8. Dogfooding commitment

The project's own public GitHub repo is tenant #1: incoming issues are classified (`bug / feature / question / needs-human`) through the production API, annotated by the owner, and carried through the entire loop publicly.

## 9. Architecture sketch (summary)

Web console + annotator surface · typed API gateway · relational database (+ cache if load demands) · async job queue (judging, clustering, training) · frontier provider adapters · open-weights inference server with dynamic LoRA adapter loading · distributed tracing, metrics, and alerting · payments provider (Stripe) · CI/CD with eval regression gates. Concrete technology choices are stakeholder-owned and recorded in `docs/STACK_DECISIONS.md` and ADRs — this document stays implementation-agnostic.

## 10. Future directions (designed for, not built)

- **Contributor revenue share ("annotation royalties").** The grand vision and potential leading differentiator: convert SME annotation from labor that trains one's replacement into an asset that pays ongoing returns. Attribution is deliberately mechanical, not causal: a contributor's share of the reliability-weighted annotations included in a shipped training set. Employer-configurable payout dials on shared metering infrastructure: (a) one-time bounty per accepted annotation, (b) graduation bonus when a fine-tune ships, (c) ongoing royalty as a percentage of metered serving spend on models the contributor's data trained. Dashboard makes it legible: "your annotations = N% of training set; model served X calls this month; your share: $Y." Paired with the oversight framing — UK/EU rules require documented human oversight, so the SME role shifts to overseer of record (judge auditing, escalations, edge cases) rather than disappearing. Staging: design the contribution ledger + attribution schema in V1 data model; ship bounties before royalties. *Open question (parked): whether royalties persist after a contributor leaves the employer.*
- **Expert eval marketplace (V2 horizon).** A two-sided marketplace pairing orgs that can't afford full-time AI staff with independent eval engineers offering human evals, axial coding, and rubric design as a service: matching, reputation scores tied to work quality, and payments handled through the platform (Stripe Connect payouts). V1 deliberately ships only the hardest prerequisite — guest-expert access governance (5.1) — with `expert_profile` and payout schemas sketched in an ADR as evidence of the roadmap.
- **SME expertise-as-a-service (V3 horizon).** The synthesis of the two ideas above. External subject-matter experts (e.g., a designer with recognized taste) register on the platform, build reputation through verified annotation quality, and list themselves as available. A team building a product enlists an expert to seed and steer a classifier: the expert's judgment is distilled into labeled data, an aligned judge, and eventually a fine-tune that runs inside the customer's agentic flows — we serve the classification step, never the whole flow. Compensation is usage-based via the contribution ledger: the more an expert-shaped endpoint is called, the more they earn, and demand raises their premium, expressed as a per-token surcharge on endpoints carrying their contribution. Reputation, attribution, and metering all reuse V1/V2 primitives (reliability scores, contribution ledger, metered billing) — which is what keeps this a roadmap rather than a fantasy.
- Free-text extraction/generation tasks; additional open-weights base families; bring-your-own-model.

## 11. Open questions

- Which open-weights base family for V1 (e.g., Llama vs Qwen small models)?
- Judge sampling rate vs cost tradeoff defaults?
- Where training jobs run (rented GPU vs managed service)?
