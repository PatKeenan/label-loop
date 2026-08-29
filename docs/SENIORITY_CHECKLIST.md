# SENIORITY_CHECKLIST.md — the blueprint this project exists to prove

This is the original outline behind the whole build: every competency a top-band
senior AI engineer should be able to demonstrate publicly. Each item maps to the
milestone (BUILD_SPINE.md) where it becomes true and the public artifact that proves
it. This file is the scoreboard — check items only when the artifact is live and
linkable. Definition of done: every box checked, every artifact verifiable by an
interviewer in under five minutes.

## 1. Core Application
- [ ] Full-stack app: web console + typed API + relational store — M0/M1 · live URL
      *(M0: all three exist and boot with one command. The artifact is a LIVE URL and
      there is no deployed environment yet — CD is M1.)*
- [ ] Real, eval-able AI feature (judgment gateway) — M1 · /docs + demo
- [ ] Streaming + structured outputs with confidence — M1 · API contract
- [ ] Versioned public API with OpenAPI + interactive docs — M1 · /openapi.json, /docs

## 2. Eval Harness (the differentiator)
- [ ] Trace capture on 100% of AI calls (input/output/model/version/tokens/cost) — M1 · trace explorer
- [ ] Annotation UI + sampling strategies (random, low-confidence, disagreement) — M5 · demo clip
- [ ] Axial coding → versioned failure taxonomy — M6 · taxonomy doc
- [ ] LLM judge validated against human labels; agreement + drift tracked — M6 · dashboard
- [ ] Eval suite gating CI (regression-blocking PR demo) — M6 · blocked-PR link
- [ ] Agreement dashboards over time, pinned to judge versions — M6 · dashboard

## 3. Fine-Tuning
- [ ] Dataset curation from annotations (dedup/split/version, reliability-aware) — M7 · dataset card
- [ ] LoRA fine-tune of small open-weights model, configs in repo — M7 · training YAML
- [ ] Held-out baseline vs fine-tune comparison — M7 · published numbers
- [ ] Honest regression/failure analysis — M7 · writeup section

## 4. Model Serving
- [ ] Inference server with dynamic per-tenant LoRA loading — M7 · ADR + demo
- [ ] Router: frontier | finetune | shadow, with fallback — M7 · shadow-mode clip
- [ ] Side-by-side quality + cost comparison in product — M7 · dashboard

## 5. Reliability & Load
- [ ] k6 scenarios: smoke, ramp, spike, soak — M0/M2 · scripts in repo
      *(M0: `infra/k6/smoke.js` runs in CI against the composed stack. Ramp, spike and
      soak are M2 — and load numbers against a fake provider would measure a hash.)*
- [ ] Circuit breakers, retries + backoff + jitter, timeouts — M2 · code + logs
- [ ] Per-key rate limiting, quota enforcement, graceful 429/503 — M2/M8 · API behavior
- [ ] Documented breaking point + degradation behavior — M2 · BREAKING_POINT.md

## 6. Auth Gauntlet
- [ ] OIDC login, sessions, server-enforced RBAC (admin/engineer/annotator) — M4 · demo
- [ ] Scoped API keys: hashed at rest, shown once, revocable, metered — M1/M4 · console
- [ ] Guest-expert access: time-boxed, scoped, audited, PII-masked — M8 · PRODUCT 5.1
- [ ] Stripe metered billing + tier quotas (keys/panels/calls) — M8 · invoice demo

## 7. Observability
- [ ] Distributed traces incl. LLM spans (tokens/cost/latency) — M3 · dashboard
- [ ] Metrics dashboards (p50/95/99, error rate, cost/min, per-key) — M3 · Grafana
- [ ] Structured logging with correlation ids; alerting; error tracking — M0/M3 · live
      *(M0: NDJSON logs carrying `request_id`, and an `ErrorReporter` port with a Sentry
      adapter. Alerting is M3, and there is nothing deployed for it to page about.)*
- [ ] Live dashboards during a load test — M3 · recorded clip

## 8. Delivery & Public Proof
- [x] Public repo, ADR discipline (0001+), conventional commits — M0 · repo
- [x] CI from day one (lint/typecheck/tests/image build, on PRs); walking skeleton
      boots via one command — M0 · Actions + compose
- [ ] CD to a live URL; automated versioning + generated CHANGELOG — M1 · Releases
- [ ] Dogfood case study: repo's own issues judged in production — M5 · case study
- [ ] Architecture writeup + demo video of eval + load findings — M8 · links

## 9. Compliance & AI Governance
- [ ] Append-only audit log (DB-grant enforced) — M8 · schema + console
- [ ] Versioning-as-evidence: any past decision reconstructable — M1+ · ADR-0003
- [ ] COMPLIANCE_READINESS.md mapped to SOC 2 / ISO 42001 / EU AI Act / UK DUAA — M8 · doc
- [ ] Data lifecycle: retention, export/deletion, PII masking — M8 · PRODUCT 5.12

## 10. Security Posture & Shared Responsibility (reframed at final review)
Customer prompt/content safety is the TENANT's domain (shared-responsibility model —
documented, AWS-style). The platform owns only its own surfaces:
- [ ] Shared-responsibility statement published (what's ours vs the tenant's) — M8 · doc
- [ ] Judge-injection hardening: untrusted trace content fenced in the platform's own
      judge/clustering prompts + adversarial eval cases proving it — M6 · eval cases
- [x] Supply-chain hygiene: dependency + secret scanning in CI — M0 · Actions config
- [ ] OWASP-basics pass on the public surface (headers, CORS, input limits) — M2 · checklist
- [ ] Per-key budget caps + spend anomaly alert (customer protection, billing-adjacent) — M8 · console
- [ ] SHOWCASE TENANT: a prompt-injection-detection judge built on the platform —
      AI-security fluency demonstrated through the product, adversarial eval set,
      taxonomy of attack patterns, candidate for the M7 fine-tune — M5-M7 · case study

## The one-sentence claims this earns (interview ammunition)
"I built a multi-tenant AI gateway with a full eval lifecycle — trace capture, SME
annotation, axial-coded taxonomy, a drift-monitored LLM judge gating CI — and used its
data to fine-tune a small model that I serve with per-tenant LoRA loading behind a
shadow-mode router, load-tested to a documented breaking point, metered to a Stripe
invoice, with every decision reconstructable from an append-only audit log."
