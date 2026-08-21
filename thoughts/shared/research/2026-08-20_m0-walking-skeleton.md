---
date: 2026-08-21T01:25:00Z
author: claude-code
status: complete
milestone: M0
topic: m0-walking-skeleton
related_adrs: [0001, 0002, 0003, 0004, 0005, 0006, 0007, 0008, 0009]
---

# Research — M0 walking skeleton

## Problem summary
M0 is the pattern layer: every architectural seam wired and proven through one thin
end-to-end thread before any feature work, booting from a fresh clone with one command.
Nothing in `apps/`, `packages/`, or `infra/` exists yet — the repo is docs, mockups, and
`.claude/commands` only, and it is **not a git repository**, so M0 starts from genesis.
The research question is therefore not "how do we extend the code" but "which of the
locked decisions in STACK_DECISIONS/ADRs must become real at M0, in what order, and
where do the docs conflict or leave a gap the human must close before planning."

## Relevant files/modules and why each matters

### Existing (constraints only — no code)
- `docs/BUILD_SPINE.md` — the M0 deliverable list quoted verbatim below; the ordering authority.
- `docs/CONVENTIONS.md` — the densest constraint document: repo shape, API envelope, id prefixes, key format, error taxonomy, logging rules, ports & adapters, `apps/api` directory shape, health/lifecycle. M0 exists to instantiate this file.
- `docs/STACK_DECISIONS.md` — register **LOCKED 2026-08-19**; D1–D12 all DECIDED. No open rows, so M0 introduces no new technology decisions — only the question of which decided technology lands at M0 vs later.
- `docs/adr/0004-runtime-framework.md` — Bun + Hono, two API surfaces in one app (OpenAPIHono `/v1` + Hono RPC internal), code-first OpenAPI. Shapes the entire `apps/api` skeleton.
- `docs/adr/0006-data-queue-serving.md` — Postgres is the only stateful service; pg-boss is the queue. M0's compose file has exactly one database container.
- `docs/adr/0007-observability-and-errors.md` — manual OTel instrumentation (Hono middleware + `llm/` only), self-hosted Grafana stack in containers, Sentry as reporting sink only.
- `docs/adr/0008-auth.md` — better-auth self-hosted for console sessions; API keys are ours and never touch better-auth on the `/v1` hot path. Directly constrains M0's "dummy web page that logs in".
- `docs/adr/0009-deploy-portability.md` — all config via env vars; `docker compose up` boots the entire stack from a fresh clone with the same images production runs.
- `docs/adr/0003-versioning-and-keys.md` — immutable `clv_` versions, per-classifier SHA-256-hashed keys shown once. M0's seed data (`org`, classifier v1, dev key) is this ADR in miniature.
- `docs/adr/0001-gateway-traces.md` — we are the inference path; the trace row is written server-side on 100% of calls, including M0's fake-provider calls.
- `docs/adr/0002-thin-sdk.md` — no SDK package ever; `/docs` (Scalar) + curl is the integration surface, so `/docs` working at M0 is load-bearing, not decoration.
- `docs/SENIORITY_CHECKLIST.md` — four boxes name M0: full-stack app (1), k6 scenarios (5), structured logging w/ correlation ids (7), public repo + ADR discipline + conventional commits + CI/CD + one-command compose (8), and **supply-chain dependency + secret scanning in CI (10)** which BUILD_SPINE's M0 list omits.
- `mockups/BRIEF.md` vs `labelloop-latest/mockups/BRIEF.md` — two different briefs; see open question 8. Irrelevant to M0's code but the stray directory needs resolving before `git init`.
- `.claude/commands/create_plan.md` — the next step's contract (phases, checkboxes, automated + manual verification, "Decisions made" → ADR stubs).

### To be created at M0 (the shape CONVENTIONS dictates)
- `packages/contracts` — error-code enum + status/retryable map, `{data, trace_id}` / `{error:{code,message}, trace_id}` envelope, classify request/response Zod schemas, id-prefix constants. Imported by api and web; nothing ships without a contract here.
- `packages/db` — Drizzle schema + forward-only migrations: `orgs`, `classifiers` (`cls_`), `classifier_versions` (`clv_`), `api_keys` (`key_`), `traces` (`tr_`), `audit_events`; plus better-auth's tables and pg-boss's schema.
- `apps/api/src/` — `config.ts` (env schema, crash-at-boot), `errors.ts` (`AppError` + one `app.onError`/`notFound`), `otel.ts`, `routes/public/v1/`, `routes/internal/`, `middleware/`, `services/`, `llm/`, `jobs/`.
- `apps/api/src/llm/` — the `ModelProvider` port, its deterministic fake adapter (port #1 per CONVENTIONS), the shared port contract test, and retry/backoff+jitter/breaker/timeout wired *around the fake*.
- `apps/web` — Vite + React + TanStack Router/Query, deliberately unstyled: log in, call the internal RPC surface, render the trace list. Must import the contracts error enum through an exhaustive switch.
- `infra/` — `docker-compose.yml` (api, web, postgres, observability, seed), dashboards-as-code, k6 smoke script.
- `.github/workflows/` — lint, typecheck, test, build (D12).

## Existing patterns and constraints that apply
- **Composition root, no DI container** (CONVENTIONS "Dependency seams"): `createApp(deps)` wired once; tests receive fakes through the same seam; every adapter passes its port's shared contract test. M0 must ship at least `ModelProvider` (+ almost certainly `Clock`, for deterministic tests) this way.
- **One `llm/` module, no exceptions** (CONVENTIONS "LLM-call rules"): M0's fake provider goes through the same timeout/retry/breaker/cost-accounting path a real provider will at M1, or M1 becomes a rewrite instead of an adapter swap.
- **Closed error taxonomy, one central handler** (CONVENTIONS "Error handling"): route handlers throw, never serialize. M0's "deliberate failing route" is the taxonomy's proof, not a feature. Note the 429 there is a *demonstration* — real per-key rate limiting is explicitly M2, and must not leak forward.
- **Frontend error map is structurally enforced**: `apps/web` maps every contracts error code through an exhaustive switch, so a new backend code fails the web typecheck. This coupling has to exist at M0 while the enum is small.
- **Envelope + ids** (CONVENTIONS "API rules"): `/v1` prefix, prefixed ULIDs, UTC ISO-8601 `_at` columns, `Idempotency-Key` accepted on mutating endpoints, classify always returns its `trace_id`.
- **Logging** (CONVENTIONS "Logging"): pino via `hono-pino`, request-scoped child logger on `c.var.logger`, **zero pino transports ever** (dev pretty-printing is a shell pipe), no request/response bodies logged, `console.log` lint-banned outside scripts.
- **Health & lifecycle**: `/healthz` + `/readyz` (DB reachable, migrations current, queue responsive); compose and deploys gate on `/readyz`; graceful shutdown "is a feature with tests".
- **Config**: every value env-driven, schema-validated at boot, crash with a named field on invalid/missing, `.env.example` exhaustive. Combined with ADR-0009's fresh-clone rule this means **M0 must boot with zero required secrets** — which is exactly why the provider is fake. Sentry's DSN must therefore be optional/no-op when unset.
- **Append-only audit log** (CLAUDE.md hard rule + CONVENTIONS "Data rules"): the app role has INSERT/SELECT only; no UPDATE/DELETE grants exist. This is a role-and-grant structure, not application logic — cheap now, painful to retrofit (open question 4).
- **Annotation-schema rule** (CLAUDE.md): every annotation-related schema carries `annotator_id` and immutable dataset-version links from day one. No annotation tables at M0, but the `clv_` FK discipline they depend on starts here.
- **Mockups are never ported** (CLAUDE.md Phase C): M0's web surface is unstyled on purpose; `tokens.css` does not enter `apps/web`.
- **Environment facts checked on this machine**: bun 1.2.2, node 22.15.0, git 2.39.5, gh 2.75.1, Docker 20.10.14 with **Compose v2.5.1** (old — stick to the plain 2.x feature set; no `include:`, no `develop.watch`), **k6 not installed**, docker daemon running.
- **Known risk seams M0 exists to de-risk early**: OTel under Bun is manual precisely because auto-instrumentation is patchy there (ADR-0004/0007); pg-boss and better-auth both drive `pg` under Bun. If any of these misbehave, M0 is the milestone where that is supposed to hurt — discovering it at M3/M4 would be the failure mode.

## Open questions — ALL RESOLVED 2026-08-20
Answered in a steering session with the stakeholder. Full reasoning for each, including
alternatives rejected and why, is in `thoughts/shared/progress/decisions-log.md`. The
planner should treat these as settled inputs.

1. **Auth depth at M0** → better-auth wired at M0 with a credential (email+password)
   provider only; real session cookie and session middleware on the internal RPC routes.
   Social/OIDC providers, role enforcement and the login UI are M4. A `role` column ships
   present-but-unenforced in the first migration. (ADR-0008)
2. **Observability container shape** → discrete containers from M0: OTel Collector +
   Tempo + Prometheus + Grafana. NOT the bundled `grafana/otel-lgtm` image. M0 scope is
   topology, datasources provisioned as code in `infra/`, and one classify span visible
   end-to-end; dashboards, alert rules and retention are M3. Loki joins at M3 via the
   Collector's filelog receiver reading container stdout. (ADR-0007 amended)
3. **Envelope identifier** → the envelope carries `request_id` (the W3C/OTel execution
   id) on every response, success and failure. `trace_id` is reserved for the `tr_` ULID
   of a stored classification and appears only in classify's `data`. The `traces` table
   stores both. CONVENTIONS amended in seven places. (ADR-0010, NEW)
4. **Two Postgres roles at M0** → yes, from the first migration: migrator (DDL) and app
   (DML). `audit_events` is also created at M0 — empty, with its `REVOKE UPDATE, DELETE`
   in place and a test proving Postgres rejects the app role's UPDATE/DELETE.
   `ALTER DEFAULT PRIVILEGES` auto-grants future tables. pg-boss installs its schema as
   the migrator, since it issues DDL on first start.
5. **Repo genesis** → public from commit 1, named `label-loop`, MIT licensed,
   conventional commits enforced by commitlint. `.gitignore` written (already on disk).
6. **CI/CD scope** → CI at M0 (lint, typecheck, tests, image build, k6 smoke, on PRs as
   well as main); CD to a live URL is M1. Images tagged with git SHA + version, never
   `:latest`; build version surfaced via `/healthz` and `service.version` on every span.
   Versions are never hand-written — release-please derives them from conventional
   commits. (ADR-0011 NEW, STACK_DECISIONS D13 NEW)
7. **Supply-chain scanning** → in M0's CI. Secret scanning (GitHub push protection +
   gitleaks) is preventative and cannot be added retroactively; dependency scanning
   (Dependabot + `bun audit`) is nearly free while the surface is still empty.
   BUILD_SPINE M0 amended so it agrees with SENIORITY_CHECKLIST 10.
8. **Conflicting mockup briefs** → Phase A PAUSED. `tokens.css` + `tokens-preview.html`
   retained; the four draft screens and `labelloop-latest/` are deleted in the commit
   AFTER `git init`, so history keeps them. All rationale extracted verbatim to
   `thoughts/shared/research/2026-08-20_phase-a-design-harvest.md`, which also lists six
   product decisions the mockups made ahead of PRODUCT.md — these are M5/M6 product debt,
   NOT M0 work, and PRODUCT.md was deliberately left unedited pending human calls.
9. **k6 execution** → from the `grafana/k6` container under a compose profile; no host
   install. Scripts committed in `infra/k6/`; M0 ships smoke only.
10. **Library approvals** → STACK_DECISIONS-row-worthy choices need sign-off + an ADR;
    smaller libraries are the planner's call if actively maintained, free of a large
    transitive tree, and promoted to a stack row retroactively if they become an
    architectural seam. Now a standing rule in CONVENTIONS "Quality gates".

**Docs changed during this session** (the planner should read the current versions, not
this doc's earlier summaries): CONVENTIONS.md, BUILD_SPINE.md (M0), SENIORITY_CHECKLIST.md,
STACK_DECISIONS.md (D13), CLAUDE.md (current phase), ADR-0007 (amended), ADR-0010 (new),
ADR-0011 (new), mockups/BRIEF.md (rewritten as a record), plus `.gitignore` created.

## Recommended approach (input to planning, not the plan)
Build M0 as one thread in thin ordered slices, each ending in something runnable, and
front-load the seams most likely to break under Bun so failure surfaces while the
codebase is still empty:

- **S0 — genesis.** `git init`, Bun workspaces, strict TS, lint (incl. the `console.log` ban), a CI workflow that is green on an empty repo. Everything after this is a conventional commit on a working tree.
- **S1 — contracts first.** Error taxonomy + envelope + id prefixes + classify schemas in `packages/contracts`. Nothing else can be written honestly before this exists.
- **S2 — api boots with no database.** `config.ts`, pino logger middleware, `errors.ts` + the single `onError`/`notFound`, `/healthz`, the deliberate failing routes (422/401/429+Retry-After/500), OpenAPIHono mounted with Scalar at `/docs`. The error taxonomy is demonstrable here, before persistence exists.
- **S3 — persistence.** `packages/db` schema + forward-only migrations + roles/grants, `/readyz`, and the seed script (org, classifier `cls_` + immutable `clv_` v1, deterministic `llk_test_` dev key printed once so the README curl works verbatim).
- **S4 — the steel thread.** `ModelProvider` port + deterministic fake + shared port contract test; `llm/` wrapping it with timeout, retry with backoff+jitter, and breaker; `POST /v1/classify/{id}` behind key auth, writing the trace row (raw payload alongside normalized fields). This is M0's centre of gravity.
- **S5 — async.** pg-boss on the same Postgres; classify enqueues one idempotent job that records its attempts; logs cover enqueue/start/finish/fail.
- **S6 — telemetry.** `otel.ts` + Hono middleware span per request and `llm/` span per provider call (tokens/cost/latency attributes), observability containers, dashboards-as-code, optional Sentry DSN.
- **S7 — the web proof.** Unstyled Vite/React app: log in, call the internal RPC surface via TanStack Query, render the trace list, map error codes through the exhaustive switch.
- **S8 — one command.** Compose everything with `/readyz` gating and dependency ordering, graceful-shutdown tests, k6 smoke, README fresh-clone walkthrough, CI complete, tag the release with a demo clip.

Two disciplines to carry through planning: the fake provider must be a *peer* of the
real one behind the port (M1 swaps an adapter, it does not rewrite a path), and every
slice that CONVENTIONS calls a pattern — central error handler, request-scoped logger,
port contract test, forward-only migration, idempotent job — gets its verification step
in the plan, because M0's deliverable is the pattern, not the feature.
