# CONVENTIONS.md — opinionated, non-negotiable unless an ADR says otherwise

## Repo shape (monorepo; tooling per STACK_DECISIONS.md)
- `apps/api` — the gateway + platform API (language/framework: STACK_DECISIONS.md D1)
- `apps/web` — console + annotator surface (framework: STACK_DECISIONS.md D2)
- `packages/contracts` — schema-validated request/response definitions; the single source of
  type truth, imported by api, web, and sdk. No endpoint ships without a contract here.
- `packages/sdk` — thin published client (M4). Generated FROM contracts, never drifts.
- `packages/db` — schema + forward-only migrations (tool: STACK_DECISIONS.md D3). No down-migrations.
- `infra/` — containers/compose, k6 scripts, dashboards-as-code, IaC.
- `docs/` — PRODUCT, STAKEHOLDER_VALUE, BUILD_SPINE, ADRs, BREAKING_POINT, PARKING_LOT.

## API rules
- Version prefix `/v1/` from day one. Breaking change = new version, never mutation.
- Every response is enveloped: success `{ data, request_id }`, failure
  `{ error: { code, message }, request_id }`. Error codes are a closed enum in contracts.
- All ids are prefixed ULIDs: `org_` (organisation), `pnl_` (panel), `pnv_` (panel
  version), `jud_` (judge), `jdv_` (judge version), `tax_` (failure taxonomy), `tr_`,
  `ann_`, `key_`, `ds_`, `ft_`, `aud_` (audit event). Greppable, sortable,
  self-describing. (`cls_`/`clv_` were retired by ADR-0019.) The one exception is
  better-auth's own tables, whose ids it mints itself (ADR-0008) — `org_members.user_id`
  therefore holds a better-auth id, not a prefixed one.
- **Two identifiers, never conflated** (ADR-0010). `request_id` is the W3C/OTel trace
  id for one HTTP execution: present on EVERY response, success or failure, on every
  endpoint, and the id a customer quotes to support. `trace_id` is a `tr_` ULID naming
  a stored evaluation row: it exists only for panel/judge evaluation, lives in `data`, is
  permanent, and is what the trace explorer and annotation surfaces address. The
  `traces` table carries both — its `tr_` primary key and a `request_id` column — so a
  business record joins to its spans for as long as the tracing backend retains them.
- All timestamps UTC ISO-8601, column suffix `_at`.
- Idempotency: mutating endpoints accept `Idempotency-Key`; evaluation is naturally
  idempotent per request and always returns its `tr_` `trace_id` in `data` (alongside
  the envelope's `request_id`).
- **The product surface is a panel of judges (ADR-0019).** A caller sends an artifact to
  `POST /v1/panels/{panel_id}/evaluate` and receives one verdict per judge, each with its
  reasoning; `POST /v1/judges/{judge_id}/evaluate` runs a single judge. We never generate
  the caller's artifact — their agent does — but we ARE the inference path for judge
  calls, which is what keeps ADR-0001 true.
- **Reasoning is emitted before the verdict**, always. These models are autoregressive, so
  a verdict generated first makes its reasoning post-hoc rationalisation. Under structured
  output this means JSON schema key order is load-bearing, not cosmetic.

## Keys & auth
- API keys: `llk_live_` / `llk_test_` prefix + 32 random bytes. SHA-256 hash stored;
  plaintext rendered exactly once at creation. Last-4 shown thereafter.
- Every key is scoped to one panel and carries its own rate limit + usage meter.
- Revocation is a status flip, never a row delete (audit trail).
- Web sessions (OIDC) and API keys are separate auth paths; API keys never grant
  console access. Roles enforced in the API layer, never only in the UI.

## Data rules
- Panel and judge configs are IMMUTABLE versions (`pnv_`, `jdv_`). Editing creates
  version n+1. Every trace, annotation, eval score, and dataset row FKs to a `jdv_`.
- **One judge per failure category, never one judge doing many things.** A judge asked to
  assess several criteria at once returns a verdict that cannot be measured, debugged, or
  attributed. Judges run as independent calls and are never bundled into one
  multi-criteria prompt (ADR-0019).
- **Judges carry a type, `code` or `llm`.** A failure mode that reduces to a schema
  assertion or a regex becomes a deterministic check: near-zero cost and latency, and
  perfect precision by construction, with nothing to align.
- **Every judge declares its POLARITY, and it is three-valued.** A verdict is not a pass:
  judges point in different directions. `is-missing-repro: true` is a failure,
  `on-brand: true` is a success, and `is-bug: true` is neither — it is a label with no
  valence. So a judge says whether answering `true` passes, fails, or **does not score at
  all**. Without this the panel score is uncomputable, because summing raw booleans across
  judges that mean opposite things is meaningless. Responses therefore carry both the raw
  `verdict` (what the annotator agrees with or corrects) and the derived `passed` (what
  the score sums), with `null` for informational judges, which are absent from both the
  numerator and the denominator.
- Annotations always carry `annotator_id`. Dataset membership is a versioned join
  table — never a boolean on the annotation.
- `audit_events` is append-only: the app role has INSERT and SELECT only; no UPDATE
  or DELETE grants exist. This is enforced by Postgres grants, not application code,
  and proven by a test asserting the app role's UPDATE/DELETE are rejected.
- **Two database roles from the first migration.** A *migrator* role owns DDL and runs
  migrations; the *app* role the API connects with holds DML only and can never alter
  schema. `ALTER DEFAULT PRIVILEGES` grants the app role on future tables automatically
  (a forgotten grant would break production silently); `audit_events` then carries an
  explicit `REVOKE UPDATE, DELETE` as the one deliberate exception. pg-boss installs its
  own schema as the migrator, never at app runtime.
- Raw provider payloads stored alongside normalized fields (rerunnable, auditable).
- Every `traces` row stores the `request_id` of the execution that produced it, so a
  stored evaluation links back to its spans (ADR-0010).

## Dependency seams (ports & adapters)
- Every external effect sits behind a small interface (a "port"): `ModelProvider`,
  `Clock`, `Mailer`, payments, GPU-training driver. Real adapters and deterministic
  fakes both implement it; the walking skeleton's fake provider is port #1.
- Injection is TS-idiomatic: constructor/factory parameters wired once at app
  composition (`createApp(deps)`). No DI container — the seam is the value, not the
  framework. Tests receive fakes through the same seam; nothing is monkey-patched.
- Base test suites live beside each port: every adapter (real or fake) must pass the
  port's shared contract test.

## Async & jobs
- Exactly one queue technology (STACK_DECISIONS.md D4) for judging, clustering,
  training kicks. Jobs are idempotent and record attempts in the DB.

## Quality gates
- Strict static typing everywhere; no untyped escape hatches without an inline justification comment.
- Contract tests per endpoint (schema-level) + integration tests on the evaluation path.
- From M6: eval suite is a required CI check.
- Conventional commits; every PR names its BUILD_SPINE milestone in the description.
- **Dependency threshold.** Anything that would be a row in STACK_DECISIONS — a
  framework, datastore, queue, hosting target, or a tool that shapes the architecture —
  needs stakeholder sign-off and an ADR. Smaller libraries are the planner's call,
  subject to three standing constraints: actively maintained, no large transitive tree,
  and any library that becomes an architectural seam is promoted to a stack row
  retroactively (a retry/breaker helper inside `llm/` is architecture, not a utility).

## LLM-call rules
- Every provider call goes through one internal `llm/` module: timeout, retry with
  backoff+jitter, circuit breaker, token/cost accounting emitted as trace span attributes.
  No fetch to a provider anywhere else in the codebase, ever.
- Prompts live in versioned judge configs, not in code.

## Error handling (the pattern, laid down once)
- **Closed taxonomy** in `packages/contracts`, each code mapping to HTTP status +
  `retryable: boolean`: `VALIDATION_ERROR` 422 · `UNAUTHORIZED` 401 · `FORBIDDEN` 403 ·
  `NOT_FOUND` 404 · `IDEMPOTENCY_CONFLICT` 409 · `RATE_LIMITED` 429 (retryable) ·
  `QUOTA_EXCEEDED` 429 (not retryable) · `PROVIDER_TIMEOUT` 504 (retryable) ·
  `PROVIDER_UNAVAILABLE` / `CIRCUIT_OPEN` 503 (retryable, `Retry-After` set) ·
  `INTERNAL` 500. New codes require a contracts PR, never an inline string.
- **`AppError`** base class (code, status, retryable, safe public message, `cause`).
  Only AppError messages cross the wire. Anything else becomes `INTERNAL`: generic
  message + request_id to the caller, full detail to the error tracker.
- **One handler**: Hono `app.onError` + `notFound` own all serialization. Route
  handlers throw; they never build error responses. Contract validation failures
  auto-map to `VALIDATION_ERROR` with field-level issues.
- Provider failures are translated to the taxonomy inside `llm/`; raw provider errors
  never reach customers.
- **Reporting ≠ handling**: the error tracker (Sentry) receives unexpected errors at
  the central handler and job-failure hooks — it is the sink, never the strategy.
- **Frontend error map**: `apps/web` imports the same error-code enum from
  `packages/contracts` and maps every code through an EXHAUSTIVE switch to its UI
  treatment (user-facing copy, fatal vs recoverable, retry affordance). A new backend
  error code fails the frontend typecheck until someone decides what the user sees —
  front/back error sync is structurally enforced, not remembered.

## Logging
- One structured JSON logger (pino) via `hono-pino` middleware: a request-scoped child
  logger on context (`c.var.logger`) carrying `request_id` automatically, with the
  `tr_` `trace_id` bound once the evaluation row exists.
  `console.log` is banned outside scripts (lint-enforced).
- **Zero pino transports, ever.** In-process shipping couples API availability to the
  log backend (a slow or unavailable backend blocks the request path, buffers
  unboundedly, or drops silently) and loses buffered lines on crash; it is also
  Node-worker machinery, flaky under Bun/bundlers. Production writes raw NDJSON to
  stdout, and aggregation happens by OUT-OF-PROCESS collection — the OTel Collector's
  filelog receiver reads container stdout and exports to Loki (M3) — never by
  in-process shipping. Dev pretty-printing is a pipe (`bun run dev | pino-pretty`),
  never in-process.
- Every line carries `request_id`; lines on the evaluation path also carry the `tr_`
  `trace_id` once the row exists. Provider calls add model, tokens, cost, latency;
  jobs log enqueue/start/finish/fail with attempt counts.
- Log levels mean things: `error` = alert-worthy, `warn` = degraded-but-serving,
  `info` = lifecycle events, `debug` = local only.
- Request/response BODIES are never logged (PII; payloads live in the traces table,
  access-controlled). Log metadata, not content.

## Directory shape (apps/api)
`src/routes/public/v1/` (OpenAPIHono) · `src/routes/internal/` (RPC) ·
`src/middleware/` · `src/services/` (business logic; routes stay thin) ·
`src/llm/` (the ONLY provider gateway) · `src/jobs/` (queue handlers) ·
`src/errors.ts` · `src/config.ts` · `src/otel.ts`.
Files kebab-case; one exported concern per file; tests co-located as `*.test.ts`.

## Config
- All config via env vars (ADR-0009), parsed and validated against a schema in
  `config.ts` at boot. Invalid or missing config = crash at startup with a named
  field, never a runtime surprise. `.env.example` is exhaustive and committed.

## Health & lifecycle
- `/healthz` (liveness: process up) and `/readyz` (readiness: DB reachable,
  migrations current, queue responsive). Compose and deploys gate on `/readyz`.
- Graceful shutdown: stop accepting, drain in-flight requests and jobs, flush
  telemetry, exit. SIGTERM is a feature with tests, not an afterthought.
