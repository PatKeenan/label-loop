# BUILD_SPINE.md — the single ordering authority

Every piece of work must name its milestone. If a task doesn't fit a milestone, it's
creep: park it in `docs/PARKING_LOT.md` and move on. Checklist categories refer to
`STAKEHOLDER_VALUE.md` section 3.

The demo narrative this spine builds toward (the interviewer flow):
log in → create a panel of judges (criteria/model = version 1) → get an API key →
curl the endpoint → watch the trace appear → annotate a few → see quality-by-version
and cost dashboards → flip shadow mode on a fine-tune.

---

## M0 — Walking skeleton (the pattern layer; Categories 1/5/6/7 in miniature)
The AmEx move: every architectural pattern wired and proven through one thin
end-to-end thread BEFORE feature work. Deliverables:
- `docker compose up` from a fresh clone boots EVERYTHING: api, web, Postgres,
  observability stack — no manual steps, seeded dev data (org, panel v1, dev key).
- One steel-thread request: `POST /v1/panels/{id}/evaluate` with a deterministic FAKE provider
  adapter (no external key needed) flowing through every layer — key auth, contract
  validation, the `llm/` module (retry/breaker wired even around the fake), trace row
  persisted, a queue job enqueued and processed, structured logs, spans in the
  dashboards, request visible in Scalar docs at `/docs`.
- Error patterns proven: a deliberate failing route demonstrating the taxonomy
  (validation 422, auth 401, rate limit 429 w/ Retry-After, internal 500 → error
  tracker with request_id).
- Dummy web page (unstyled) that logs in, calls the internal API, renders the trace
  list — proving the RPC surface and auth session end-to-end.
- CI green on lint, typecheck, tests (incl. the append-only grant test); k6 smoke
  script runs against the skeleton. CI runs on pull requests, not just main, so M6's
  eval gate plugs into machinery that already exists. Container images are tagged with
  the git SHA and version — never `:latest` — and the running app reports its build via
  `/healthz` and `service.version` on every span (ADR-0011). CI only: the deploy to a
  live URL is M1.
- Supply-chain hygiene in CI from the first commit (SENIORITY_CHECKLIST 10): secret
  scanning (GitHub push protection + gitleaks) and dependency scanning (Dependabot +
  `bun audit`). Secret scanning is preventative and cannot be added retroactively — a
  key in the history of a public repo must be rotated regardless.
**Demo moment:** fresh clone → one command → working system with observable guts.
**Not now:** any real feature depth; the skeleton is deliberately anemic.

## M1 — Endpoint spine (Categories 1, 6-part, 8-part)
Replace M0's fake adapter with one real frontier provider; structured JSON out
(label, confidence, trace_id). Server-side trace persisted on every call (input, output,
model, judge_version, latency, tokens, cost). API-key auth: hashed at rest, shown
once, scoped to panel. Relational DB + forward-only migrations. CI/CD deploying to a live URL from
day one. Classifier + version rows seeded by script (no UI yet).
**Demo moment:** curl with a key returns a label; trace row visible in DB.
**Not now:** UI, judge, billing, more providers.

## M2 — Resilience & load baseline (Category 5)
Per-key rate limiting, request timeouts, retries with exponential backoff + jitter
toward the provider, circuit breaker on provider failure, graceful 429/503 envelopes.
k6: smoke + ramp + spike scripts committed. `docs/BREAKING_POINT.md` v0 with real numbers.
**Demo moment:** k6 report; circuit breaker visibly tripping and recovering in logs.
**Not now:** autoscaling, multi-region, queue-based buffering.

## M3 — Observability (Category 7)
Distributed tracing with LLM spans (tokens, cost, latency, provider), metrics
dashboards (p50/p95/p99, error rate, cost/min, per-key usage), error tracking, one
alert rule. Tooling per STACK_DECISIONS.md D6.
**Demo moment:** live dashboards during a k6 run.
**Not now:** log aggregation products, SLO tooling.

## M4 — Console + auth + the interviewer flow (Categories 6, 1)
OIDC login; roles admin/engineer/annotator enforced server-side. Minimal engineer
console: create panel and judges (wizard → immutable version 1), issue/revoke keys, raw
trace table. Publish thin client SDK (typed client generated from contracts,
retries+jitter, idempotency header; language/registry per STACK_DECISIONS.md D5) — see ADR-0002.
**Demo moment:** the full interviewer flow end-to-end, no seeding scripts.
**Not now:** annotator UI polish, guest experts, taxonomy tooling.

## M5 — Annotation loop (Category 2-part)
Annotator surface (screen: annotator-session): one trace at a time, agree/correct,
failure note, session goal. Sampling queues: random, low-confidence. Every annotation
row carries annotator_id + judge_version + dataset-version linkage (ADR-0003).
Dogfooding tenant live: this repo's GitHub issues judged by a panel via the production API.
Showcase tenant candidate: a prompt-injection-detection judge (adversarial eval
set; natural fine-tune target for M7; demonstrates AI-security fluency via product).
**Demo moment:** annotate 20 real traces in under 5 minutes on camera.
**Not now:** gamification, inter-annotator stats, multi-annotator consensus.

## M6 — Eval harness (Category 2 complete)
Axial coding pass over failure notes → versioned taxonomy, with each category triaged
into a deterministic `code` check or an `llm` judge. Judges configured from taxonomy +
rubric, one per category. **Alignment sessions**: a discrete, versioned run of one judge
against a held-out labeled set, ending in accept-or-revise, with the disagreement view as
its working surface — plus re-alignment when drift alerts fire, since a judge's agreement
is a claim with a date on it. Judge-vs-human agreement tracked; judge-disagreement
sampling queue. Judge prompts fence untrusted trace content;
adversarial eval cases prove injection resistance (the judge is OUR model call).
Eval suite runs in CI and gates merges on regression. Console dashboard (screen:
console-dashboard): agreement by judge version + cost per call.
**Demo moment:** open a PR that worsens the prompt; CI blocks it with eval diffs.
**Not now:** automated clustering UI; a script + human confirmation is fine.

## M7 — Fine-tune & serving (Categories 3, 4)
> **DECISION REQUIRED BEFORE PLANNING THIS MILESTONE — do not start M7 without it.**
> The fine-tuned judge is where the business model lives (PRODUCT 5.11): bring-your-own-key
> is a hard enterprise requirement, so frontier judging earns subscription revenue only,
> and metered inference on the model *we* trained and host is the durable margin — with
> the SME surcharge riding on it. But PRODUCT 5.9 and core-loop step 10 **promise adapter
> download for graduated tenants**, which is incompatible with being that model's
> exclusive inference provider, and the BYOK enterprises most likely to demand
> portability are exactly the ones this bites. Resolve it — download on a higher tier,
> download as an exit right that ends the loop, or withdraw the promise — and record it as
> an ADR before any of this is built. Full pros and cons: PRODUCT 5.11; provenance:
> `thoughts/shared/research/2026-08-22_judge-as-a-service-reframe.md`.

Curate dataset from annotations (dedup, split, version). LoRA-train one small
open-weights model. Held-out comparison vs frontier, published honestly. Inference
server with dynamic adapter loading (STACK_DECISIONS.md D7); router flag
frontier|finetune|shadow; shadow writes both
outputs to the trace.
**Demo moment:** shadow-mode side-by-side with live cost delta on the dashboard.
**Not now:** multiple base families, adapter download portal, training UI (CLI is fine).

## M8 — Billing, compliance, public proof (Categories 6, 9, 8)
> **DECISION REQUIRED BEFORE PLANNING THIS MILESTONE.** Pricing cannot assume a margin on
> frontier tokens, because BYOK tenants route judge calls to their own provider. Settle
> what subscriptions must cover across M1–M7, what per-token pricing on fine-tuned judges
> looks like, and the GPU density the model needs to clear its floor — one tenant's LoRA
> on a dedicated GPU costs more than frontier tokens, so multi-adapter serving is what
> makes the margin real. See PRODUCT 5.11 and the M7 gate above; they are one decision.

Stripe metered billing; tier quotas (max panels, max keys, monthly calls) enforced
at the endpoint. Append-only audit log surfaced in console. `COMPLIANCE_READINESS.md`
control mapping. Final writeup + demo video; ADR index complete.
**Demo moment:** usage on a Stripe invoice matching the metrics dashboards' per-key numbers.
**Not now:** self-serve plan changes, dunning, tax.

---

## Standing rules
- Two mockup screens are load-bearing (annotator-session, console-dashboard) plus the
  panel-create wizard; every other surface ships as an unstyled table until a
  milestone demands otherwise.
- Every milestone ends with a tagged release, a short demo clip/GIF, and an updated
  README section — the public commit narrative is a deliverable.
- If a task serves no checklist category, it waits.
