# Stakeholder Value Document — LabelLoop

**Stakeholder:** [You], sole builder · **Version:** 0.1 · **Last updated:** 2026-08-18

> This document captures *why* each part of the product exists relative to the stakeholder's actual goal. The product document describes what we build; this one is the contract with the goal itself. If a feature can't be traced to a row here, it's scope creep.

---

## 1. The stakeholder goal

Publicly and verifiably demonstrate the complete skill set of a very senior, high-demand AI engineer before entering the interview circuit. The product is the vehicle; the goal is the proof. "Publicly verifiable" means: live demo, public repo with honest commit history, published eval results and load-test findings — claims an interviewer can check, not just hear.

Corollary goals:
- Generate authentic interview narratives ("when our judge drifted, here's what we did") rather than rehearsed answers.
- Produce honest failure analysis — senior engineers are distinguished by what they publish about failures, not successes.
- Cover the original competency checklist (categories 1–8) with no gaps.

## 2. Why THIS product (and not a simpler app)

- The eval lifecycle is not bolted on — it **is** the product. Every checklist item in evals becomes a user-facing feature, so nothing feels contrived.
- Multi-tenancy, scoped tokens, metered billing, and per-tenant adapter serving are the hard, rarely-demonstrated parts of senior platform work. A single-user demo app cannot surface them.
- Dogfooding (classifying the repo's own issues) makes the public proof self-referential: the portfolio project generates its own real traffic, real annotations, and a real case study.
- The category exists commercially (OpenPipe, Braintrust, LangSmith adjacency), which signals product judgment: rebuilding a validated category solo, not inventing a toy.

## 3. Traceability: checklist category → product feature → what it proves

### Category 1 — Core Application
| Product feature | Why it delivers the goal |
|---|---|
| Full-stack app: web console + typed API + relational store | Table-stakes full-stack proof, but in service of a real product, not a todo app. |
| Structured-output classification API w/ streaming | Shows modern LLM API design: schemas, confidence, trace IDs — the details seniors get right. |

### Category 2 — Eval Harness (the differentiator)
| Product feature | Why it delivers the goal |
|---|---|
| Full trace capture | Proves I treat LLM calls as data-producing events, the foundation of all evals. |
| Annotation UI + sampling strategies | Demonstrates I can build the human loop, not just consume it — including *which* traces are worth human time (low-confidence, judge-disagreement sampling). |
| Role-adaptive annotator UX (minimal SME flow vs engineer console) | Attacks the real bottleneck — SME willingness — where incumbent tools fail. Shows UX judgment applied to data quality, and turns RBAC into product architecture, not a checkbox. |
| Calibrated gamification (honeypots, agreement weighting, consistency re-serves) | Demonstrates Goodhart-aware incentive design: rewarding calibrated accuracy, not volume — the failure mode most gamified systems fall into. |
| Axial coding → versioned failure taxonomy | The rarest skill on the list. Shows qualitative-research rigor applied to model behavior, productized. |
| LLM judge + judge-vs-human agreement tracking | Proves I know judges must be validated and *monitored for drift*, not trusted. This is the interview story most candidates can't tell. |
| Eval suite gating CI | Shows evals as engineering infrastructure (regression gates), not notebooks. |
| Score dashboards over time / per version | Public, verifiable quality history — the "receipts." |

### Category 3 — Fine-Tuning
| Product feature | Why it delivers the goal |
|---|---|
| Threshold-gated fine-tune unlock | Encodes the judgment call of *when* fine-tuning is justified — a senior-level decision, made legible in product form. |
| Dataset curation from annotations | Proves data-centric ML skills: dedup, splits, leakage avoidance, versioning. |
| Reliability-weighted label aggregation (Dawid-Skene-style) | A UX feature converted into a data-quality technique: annotator reliability scores weight the training labels — a senior ML story almost nobody demonstrates. |
| LoRA training + held-out comparison | The headline: "fine-tuned a small model to approach frontier quality at ~10x lower cost" — with published numbers. |
| Honest regression/failure analysis | Publishing where the fine-tune *loses* is the credibility multiplier. |

### Category 4 — Model Serving
| Product feature | Why it delivers the goal |
|---|---|
| Inference server w/ dynamic per-tenant LoRA loading | Genuinely hard, rarely demonstrated publicly; the strongest pure-infrastructure flex in the project. |
| Router (frontier/finetune/shadow) + failover | Shows production model-ops: shadow deployments, cutover discipline, provider fallback. |

### Category 5 — Reliability & Load
| Product feature | Why it delivers the goal |
|---|---|
| Rate limits, circuit breakers, backoff+jitter | These exist because the product has *real external consumers* (tenant agents), so the resilience work is motivated, not decorative. |
| k6 scenarios + documented breaking point | "Here is where it breaks and how it degrades" is a senior artifact; most portfolios only show green dashboards. |

### Category 6 — Auth Gauntlet
| Product feature | Why it delivers the goal |
|---|---|
| OAuth/OIDC + roles (admin/engineer/annotator) | RBAC is motivated by the product (annotators ≠ admins), so it demonstrates real authorization design. |
| Scoped per-classifier API keys, rotation | Machine-to-machine auth at tenant scale — the part of "auth" that separates seniors from tutorial-followers. |
| Guest-expert access (time-boxed, classifier-scoped, audited, PII-masked) | Third-party access governance — the hardest slice of a future marketplace, delivered as auth design. A distinctly senior access-control story. |
| Stripe metered billing | Revenue infrastructure: webhooks, idempotency, usage metering — a competency gap in nearly all portfolios. |

### Category 7 — Observability
| Product feature | Why it delivers the goal |
|---|---|
| Distributed traces incl. LLM spans (tokens/cost/latency) | Proves I instrument AI systems as first-class telemetry, including cost as a metric. |
| Metrics, dashboards, alerting + error tracking | Standard senior ops proof, made non-trivial by multi-tenant dimensions. |

### Category 8 — Delivery & Public Proof
| Product feature | Why it delivers the goal |
|---|---|
| Public repo, ADRs, CI/CD, IaC | Verifiable engineering judgment: the *decisions*, not just the code. |
| Dogfood case study (repo's own issues) | Self-generating public evidence: real traffic, real annotations, real results. |
| Writeup/video of eval + load findings | The artifact interviewers actually consume; converts the build into narrative. |

### Category 9 — Compliance & AI Governance (added v0.2)
| Product feature | Why it delivers the goal |
|---|---|
| Immutable audit log + versioned decision reconstruction | Directly answers the demand UK/EU regulators have converged on: prove what the AI did, why, and who oversaw it. Demonstrates regulatory fluency as engineering, not paperwork. |
| Public `COMPLIANCE_READINESS.md` control mapping (SOC 2 TSC, ISO 42001, EU AI Act, UK DUAA) | "I built this SOC 2-ready and documented the mapping" is verifiable and credible — a stronger individual signal than a cert, and exactly what startups need when the first enterprise deal demands one. |
| Product-as-compliance-enabler positioning (tenants' oversight evidence) | Shows market awareness: recognizing that the eval loop doubles as customers' AI audit-trail obligation is a product insight most engineers miss. |
| Data lifecycle controls (retention, deletion, PII masking) | Privacy engineering demonstrated in a multi-tenant context — table stakes for senior platform roles, rarely shown publicly. |

## 4. Value beyond the checklist

- **Cost fluency:** the frontier-vs-finetune dollar dashboard trains and demonstrates unit-economics thinking — increasingly what separates senior AI engineers.
- **Product judgment:** threshold gates, sampling strategies, and shadow mode are all *decisions encoded as features*; each is an interview answer.
- **Compounding narrative:** every phase ends demoable, so the public commit history itself tells a story of disciplined execution.
- **Scope judgment made legible:** the expert marketplace is explicitly designed-for-not-built — guest-expert access ships, while payout/reputation schemas live only in an ADR. Knowing what *not* to build is half the interview.
- **Economic-mechanism thinking:** the contributor revenue-share vision (annotation royalties) addresses the industry's unspoken problem — SMEs rationally fear training their replacement. Attributable, metered payouts plus the regulator-mandated "overseer of record" role reframe annotation as asset-building. Even as a designed-not-built vision with a shipped contribution ledger, it demonstrates incentive design and market insight far beyond typical engineering scope — and it's a memorable interview curveball.

## 5. Anti-goals (protecting the stakeholder)

- Do not chase feature breadth (extraction, generation, multi-region) at the expense of loop depth — the goal is covered by depth.
- Do not hide bad results; publish them. Honest failure analysis is a stated deliverable, not a risk.
- Do not let the platform vision delay Phase 1 demoability; the checklist is served by shipped increments, not architecture diagrams.

## 6. Definition of done (for the stakeholder, not the product)

The goal is met when every row in section 3 has a public, linkable artifact (demo, dashboard, doc, or writeup) an interviewer could verify in under five minutes.
