---
date: 2026-08-29T00:00:00Z
author: claude-code
status: complete
approved_at: 2026-08-29T00:00:00Z
approved_by: Pat Keenan
milestone: M1
topic: m1-endpoint-spine
related_adrs: [0001, 0003, 0007, 0009, 0010, 0011, 0012, 0013, 0016, 0019, 0020, 0021,
               0022, 0023, 0024, 0025, 0026, 0027, 0028, 0029]
---

# Plan — M1 endpoint spine

## Goal
Replace M0's deterministic fake with a real OpenRouter adapter behind the same port
(ADR-0021), make an immutable judge version pin a *capability contract* rather than a model
name (ADR-0022) with `data_collection: 'deny'` written into every pin (ADR-0023), persist
tokens and money on `trace_verdicts` — columns that do not exist today. M0 proved the
path; M1 puts a real dependency and a real bill on it, and the honest measure of success is
that nothing downstream of `src/llm/` needed rewriting to absorb either.

Serves **M1 — Endpoint spine** of `docs/BUILD_SPINE.md`. Two of that milestone's lines
were already discharged at M0 and are not re-litigated here: API-key auth (hashed, shown
once, panel-scoped) and the relational DB with forward-only migrations. What remains is:
one real frontier provider with structured JSON out · tokens and cost on every persisted
trace · judge/version rows seeded by script against real models.

**M1 no longer carries a CD line.** By stakeholder decision on 2026-08-29, deploying to a
live URL moved out of this milestone and became the **first deliverable of M8**: everything
through M7 runs on `docker compose`, and the console, issued keys, data in the panel, error
analysis, open and axial coding, judge creation, the configuration surface and a fine-tune
all land before anything is deployed. `docs/BUILD_SPINE.md` (M0 pointer, M1, M8),
`docs/SENIORITY_CHECKLIST.md` and the decisions log are amended accordingly, including the
named cost of deploying late. **So the five phases below are M1 in full, not a subset of it.**
The deploy work is not lost: it is banked verbatim in the appendix, ready for whoever plans M8.

Source research: `thoughts/shared/research/2026-08-28_m1-endpoint-spine.md` — reviewed
2026-08-28, all seven open questions settled, then validated against the live API with a
real key on 2026-08-29. D1/D3/D4/D11 became **ADR-0022**, D2 became **ADR-0023**, and D9's
topology is recorded in `thoughts/shared/progress/decisions-log.md` and as an amendment to
STACK_DECISIONS **D10**.

**No new stack rows.** Every technology this plan touches is already DECIDED: OpenRouter
(D15), Railway + GHCR + Railway Pro (D10 as amended 2026-08-29), GitHub Actions (D12),
Postgres + Drizzle (D3). **No new npm dependency is introduced at all** — the adapter is
plain `fetch` (ADR-0012, ADR-0021) and the provider JSON schema is derived with Zod 4's
own `z.toJSONSchema`, which is already in the tree.

---

## Phase P1 — The pin, the port, and a fourth failure kind
**Slice goal:** the type layer every later phase writes against exists and is tested, with
no network call and no migration in it. Nothing here is reversible-by-accident, which is
why it is separated from the adapter that will consume it.

Files:
- `packages/contracts/src/model-pin.ts` (new) + `model-pin.test.ts`
  - `modelPinSchema`: `capabilities: string[]` (required provider parameters — at M1 always
    `['structured_outputs']`), `data_collection: z.literal('deny')` (ADR-0023: one writable
    value, written as a value on every row), `quantizations?: string[]` (optional; omitted
    means unconstrained), `reasoning: { effort: 'none' | 'low' | 'medium' | 'high' }`
    defaulting to `'none'` (ADR-0022 / D11). **The field is always present and always a
    concrete literal** — there is no "inherit the provider's default", because a pin that says
    nothing is a pin whose meaning changes when the provider changes its mind, which is the
    exact drift a frozen `jdv_` exists to prevent.
  - `MODEL_ROUTES = ['fake', 'openrouter'] as const`, `parseModelRef(model)` →
    `{ route, nativeId }`, rejecting anything without a known prefix. The `<route>:<id>`
    grammar is ADR-0022's, and `finetune:` is additive at M7.
  - `DEFAULT_FAKE_PIN` — the pin every `fake:` judge carries, so the CHECK in P4 can be the
    clean mirror ADR-0022 specifies rather than a route-conditional special case.
- `packages/contracts/src/index.ts` — export the above.
- `apps/api/src/llm/provider.port.ts`
  - `JudgeCall.pin?: ModelPin` — the routing constraints for this call. Optional because
    `fake:` has no endpoints to constrain.
  - `TokenUsage.reasoning?: number` — billed deliberation we cannot see or store (D11), so
    cost stays explicable even where it is invisible.
  - `ProviderResult.costUsd?: number` — what the provider itself says this call cost.
  - `ProviderResult.availableEndpoints?: number` — how many endpoints survived the pin, from
    the provider's routing metadata. **This is what keeps the port one method:** ADR-0022's
    creation-time validation is then an ordinary `evaluate()` call, not a second verb every
    future adapter has to implement.
  - `ProviderFailureKind` gains `'misconfigured'`.
- `apps/api/src/llm/index.ts` — the three tables and one new branch:
  - `RETRYABLE.misconfigured = false`, `AFFECTS_HEALTH.misconfigured = false` (nothing for a
    half-open probe to recover).
  - `misconfigured` gets its own branch *before* the generic one: maps to `INTERNAL`, sets
    `cause` so `evaluate.ts` forwards it to the error reporter, and logs at **`error`** —
    CONVENTIONS defines `error` as alert-worthy, and this never self-heals and takes every
    judge down at once (D6). It sets the `failure_kind` span attribute like any other kind,
    so M3 can tell "OpenRouter is flaky" from "we did not pay the bill".
  - **Deliberately not surfaced on `/readyz`** (D6): the console and trace explorer are fine,
    and marking the instance unready would produce a Railway restart loop over a condition no
    restart fixes.
- `apps/api/src/llm/gateway.test.ts` — cases for the new kind.

- [x] `modelPinSchema` round-trips, rejects `data_collection: 'allow'`, and defaults
      `reasoning.effort` to `'none'`
- [x] `parseModelRef` accepts `fake:deterministic` and `openrouter:anthropic/claude-sonnet-5`,
      rejects a bare `claude-sonnet-5` and an unknown prefix
- [x] A `misconfigured` failure is **not retried** (exactly one provider call)
- [x] A `misconfigured` failure does **not** move the breaker off `closed`
- [x] It returns `INTERNAL` with `cause` set, and the outcome carries no provider prose
- [x] It is logged at `error`, and the attempt span carries `failure_kind: 'misconfigured'`
- [x] The existing gateway/breaker/retry/cost suites still pass unchanged

**Automated verification**
```bash
bun run lint && bun run typecheck && bun test
```

**Manual verification**
- Read `model-pin.ts` as a frozen public contract: this shape goes into a `jdv_` row in P4
  and ADR-0003 says it is forever. Is `quantizations` optional the right call, and is
  `capabilities` a free string array rather than an enum?

---

## Phase P2 — The OpenRouter adapter
**Slice goal:** a real provider passes the *existing* shared contract suite, offline and
deterministically, and every shape of OpenRouter failure is mapped onto the port's four
kinds rather than leaking.

Files (all inside `apps/api/src/llm/`, which is the fence — ADR-0016):
- `judge-schema.ts` + `judge-schema.test.ts` — derive the provider JSON schema from
  `judgeOutputSchema` via `z.toJSONSchema`, then post-process: `additionalProperties: false`,
  all four properties required, `$ref`/`$defs` inlined, OpenAPI-only keys stripped. Deriving
  rather than hand-writing is what makes wire-schema drift from the contract impossible.
  Also exports `topLevelKeyOrder(json: string): string[]` — a depth-aware scan of the **raw
  response text**.
- `openrouter-provider.ts` + `openrouter-provider.test.ts` —
  `createOpenRouterProvider({ apiKey, fetch = globalThis.fetch, baseUrl })`.
  - Request: `POST /api/v1/chat/completions` with `response_format: {type: 'json_schema',
    json_schema: {strict: true, schema}}`, `reasoning` (`{enabled:false}` for effort `none`,
    else `{effort}`), and `provider: { require_parameters: true, data_collection: 'deny',
    quantizations? }` built **from the pin**. Header `X-OpenRouter-Metadata: enabled`, because
    which endpoint answered is opt-in and is the whole of ADR-0022's `served_by` story.
  - Response: assert key order on the raw text first (out of order → `invalid_output`), then
    `judgeOutputSchema.safeParse`. Strict-mode enforcement varies by upstream, and a model
    emitting `verdict` first produces something Zod accepts while silently deleting the
    deliberation ADR-0019 exists to force.
  - `servedBy` = the **dated** id from `openrouter_metadata.endpoints.available[].model`
    (`anthropic/claude-sonnet-5-20260630`), falling back to `response.model`.
  - `costUsd` = `usage.cost` (verified 1:1 USD, three models, 2026-08-29).
    `usage.reasoning` from the completion-token details.
  - Failure mapping — the table this phase exists for:

    | From OpenRouter | Kind | Why |
    |---|---|---|
    | Aborted signal | `timeout` | The contract suite requires it |
    | 408, network deadline | `timeout` | The call did not complete |
    | 429, 502, 5xx, **503 no-route** | `unavailable` | Retryable, counts against health |
    | 401, 402 | `misconfigured` | Never self-heals; a retry loop is a lie (D6) |
    | 400 *without* moderation metadata | `misconfigured` | A request the provider calls malformed is our bug, and retrying is the same answer twice |
    | 400 *with* `error.metadata.reasons`, 403 guardrail | `invalid_output` | A refusal **completed** (D7) |
    | 200 with no usable message / `finish_reason: "error"` | `invalid_output` | Completed, unusable |
    | Unknown route prefix, unknown slug (404) | `unavailable` | The contract suite's `unknownModel` case |
- `provider-registry.ts` + test — prefix dispatch across adapters (`fake:` → the fake,
  `openrouter:` → this one). An unknown or unregistered prefix throws `unavailable`, so the
  composite itself satisfies the shared contract suite.
- `apps/api/src/server.ts:56` — the one line ADR-0021 is about: the registry replaces
  `createFakeProvider()`, with the OpenRouter adapter registered only when a key is present.
- `apps/api/src/architecture.test.ts` — add `openrouter\.ai` to `providerHost`. Write it
  **escaped**, exactly like the existing entries, so the rule does not match its own source.
- `scripts/verify-pin.ts` + a root `verify:pin` script — one real call against a given model
  and pin, printing key order, `usage.cost`, `served_by` and the available-endpoint count.
  This is the live check, and it is a script rather than a test on purpose (see Decisions).

- [x] `describeModelProviderContract` is **imported**, not reimplemented, and passes against
      a stubbed `fetch` — including the abort case and the unknown-model case
- [x] The derived schema has exactly `rationale, reasons, verdict, confidence`, **in that
      order**, all required, `additionalProperties: false`, and no `$ref`
- [x] `topLevelKeyOrder` ignores keys nested inside `reasons` and inside string literals
- [x] A response with `verdict` emitted first is `invalid_output`, **even though Zod accepts it**
- [x] Every row of the failure table above has a test
- [x] The request body carries `require_parameters: true` and `data_collection: 'deny'`
      whenever a pin is supplied, and `reasoning: {enabled:false}` for effort `none`
- [x] **A moderation payload never reaches a log line or a span** — asserted with a fake
      logger and an in-memory span exporter against a 400 carrying `flagged_input` (D7)
- [x] `architecture.test.ts` is green with the hostname added, and still catches a planted
      `fetch(` in `apps/api/src/services/`
- [x] The per-attempt timeout is **re-derived, not inherited**: run `verify:pin` against a
      ~2,000-token artifact on all three seed models, record the latencies in this plan's
      deviations, and set `DEFAULT_RETRY_POLICY.timeoutMs` to a value the slowest clears with
      headroom. M2's k6 work inherits whatever this phase writes down.

**Automated verification**
```bash
bun run lint && bun run typecheck && bun test
```

**Manual verification**
- With a real key exported: `bun run verify:pin openrouter:anthropic/claude-sonnet-5` prints
  a well-ordered response, a non-zero `usage.cost`, a dated `served_by`, and an endpoint count.
- Point it at a nonsense model and confirm the failure is a clean `unavailable`, not a stack
  trace; unset the key and confirm 401 surfaces as `misconfigured` logged at `error`.

---

## Phase P3 — Tokens and money on the trace
**Slice goal:** M1's spine line — "input, output, model, judge_version, latency, tokens,
cost" — becomes true. `trace_verdicts` has no token or cost column at all today.

Files:
- `apps/api/src/llm/cost.ts` — `costOf(model, usage, reportedUsd?)` prefers the
  provider-reported figure and sets `priced: true` only when it has one; falls back to the
  table otherwise. `MODEL_PRICES` **shrinks to the `fake:` entry** rather than growing
  (D8: cost is now a fetch, not a maintained literal). `CallCost` gains `reasoningTokens`.
- `apps/api/src/llm/index.ts` — pass `value.costUsd` into `costOf`; add
  `reasoning_tokens` to the debug line.
- `apps/api/src/llm/attributes.ts` — `ATTR_REASONING_TOKENS = 'labelloop.reasoning_tokens'`,
  namespaced `labelloop.*` per that file's own stated rule (no convention names it).
- `packages/db/src/schema/trace-verdicts.ts` + generated migration `0007_*.sql` —
  `input_tokens integer`, `output_tokens integer`, `reasoning_tokens integer`,
  `cost_usd numeric(16,10)`, `cost_priced boolean not null default false`.
- `apps/api/src/repositories/traces.ts` — `TraceVerdictRow` gains the five fields.
- `apps/api/src/services/evaluate.ts` — `toVerdictRows` writes them; they are null for every
  status but `evaluated`, the same rule the existing nullable columns already follow.

- [x] `costOf` returns the reported figure with `priced: true` when given one
- [x] It falls back to the table, and still reports `priced: false` for an unpriced model —
      the state the code deliberately reports rather than guesses around
- [x] The migration applies forward-only on a database seeded by the previous migration
- [x] An evaluated verdict row carries non-null tokens and `cost_usd`; a failed/errored one
      carries nulls and `cost_priced = false`
- [x] `cost_usd` reads back as an exact decimal, not a float approximation
- [x] The judge span carries `labelloop.reasoning_tokens` when the provider reported any

**Automated verification**
```bash
bun run db:migrate && bun test && bun run typecheck
```

**Manual verification**
- `docker compose … up -d --wait`, curl the seeded panel, then
  `select judge_version_id, input_tokens, output_tokens, cost_usd, cost_priced from trace_verdicts;`
  — with fake models the cost is genuinely zero and `cost_priced` is true, which is exactly
  the ambiguity `priced` exists to remove.

---

## Phase P4 — `model_pin`: the frozen column, and validation before it freezes
**Slice goal:** ADR-0022 lands in the schema, in the read path, and at creation time. This
is the phase that writes a public contract ADR-0003 freezes forever.

Files:
- `packages/db/src/schema/judge-versions.ts` + migration `0008_*.sql`:
  - `model_pin jsonb`, with the mirror of the existing model/type CHECK:
    `judge_versions_pin_matches_type` — `code` → NULL, `llm` → NOT NULL.
  - `model_pin_validation jsonb` (nullable) — `{validated_at, available_endpoints,
    served_by}`. A separate column because the pin is a *constraint* translated onto the
    wire and this is an *observation*; putting the count inside the pin would ship
    non-request data in the request body.
  - **The migration backfills before it constrains.** Existing `llm` rows are the four
    seeded `fake:deterministic` judges: `UPDATE … SET model_pin = <default fake pin> WHERE
    type = 'llm' AND model_pin IS NULL`, then `ADD CONSTRAINT`. Hand-inserted into the
    generated SQL, in that order; forward-only, no down migration (ADR-0006 / CONVENTIONS).
- `apps/api/src/llm/validate-pin.ts` + test — `validatePin({ provider, model, pin })` makes
  **one real judge call** with a fixed probe artifact and returns
  `{ ok, availableEndpoints, servedBy }` or a reason. Three things nothing static can prove
  (ADR-0022): the pin is satisfiable (an empty pool is a 503), how many endpoints survive it
  (`gpt-5.6-sol` measured **1 of 5**), and that the model honours the schema *in the required
  key order*. `fake:` routes short-circuit to `ok` — there is nothing to route.
- `apps/api/src/repositories/panels.ts` — `PanelJudge.modelPin`; `findLivePanel` selects it.
- `apps/api/src/services/evaluate.ts` — `runJudge` passes the pin into `gateway.judge`.
- `packages/db/src/schema/immutable-versions.test.ts` / `constraints.test.ts` — new cases.

- [x] A `code` judge with a non-null `model_pin` is **rejected by Postgres**
- [x] An `llm` judge with a null `model_pin` is rejected by Postgres
- [x] The migration applies cleanly to a database holding the four M0-seeded judges, and
      they come out with the default fake pin
- [x] `validatePin` returns the endpoint count for a satisfiable pin, and a named reason for
      an unsatisfiable one, without throwing
- [x] `validatePin` on a `fake:` model makes no HTTP call
- [x] The pin from the row reaches the adapter's request body — asserted end-to-end through
      `evaluate()` with a stubbed `fetch`
- [x] A frozen `jdv_` still cannot be UPDATEd (the existing immutability test covers the new
      columns too)

**Automated verification**
```bash
bun run db:generate && bun run db:migrate && bun test && bun run lint
```

**Manual verification**
- `\d judge_versions` shows both columns and both CHECKs.
- Hand-write a pin naming a capability nothing supports and run `validatePin`: it must come
  back as a clean, named failure. That is the moment ADR-0023 says a permanently broken judge
  becomes a form error, and M4's wizard is where it becomes literal.

---

## Phase P5 — The seed pins three real models
**Slice goal:** one code path that gives a fresh clone a free, deterministic, zero-secret
boot and gives anyone holding a key a genuine three-lab, three-price demo — with no
branching on whether a key exists.

Files:
- `apps/api/src/config.ts` — `OPENROUTER_API_KEY: z.string().min(1).optional()`, added to the
  production `superRefine` beside the build-provenance guards: **optional in dev and test,
  required in production**. An API deployed to judge with no key is not a degraded system,
  it is a broken one, and boot is where that should be said.
- `scripts/seed.ts` — `SEED_MODEL_A/B/C`, all defaulting to `fake:deterministic` (D10):

  | Judge | Var | Value with a key set | Price /M |
  |---|---|---|---|
  | `is-bug` | `SEED_MODEL_A` | `openrouter:anthropic/claude-sonnet-5` | $2.00 / $10.00 |
  | `is-feature` | `SEED_MODEL_B` | `openrouter:openai/gpt-5.6-sol` | $2.00 / $10.00 |
  | `is-question` | `SEED_MODEL_C` | `openrouter:google/gemini-3.7-flash` | $0.75 / $3.75 |
  | `needs-human` | `SEED_MODEL_A` | `openrouter:anthropic/claude-sonnet-5` | $2.00 / $10.00 |

  Two fragilities are kept **knowingly**, both measured on 2026-08-29: `gpt-5.6-sol` has
  exactly one endpoint under the pin, so it has no failover — a judge with a real failure
  mode is a better breaker demonstration than three identical ones; and `gemini-3.7-flash`
  has `reasoning.mandatory: true`, so D11's `none` default cannot apply to it and its pin
  carries **its own default effort, read from `reasoning.default_effort` on the models API at
  implementation time and written into the pin as a literal** (Decision 17). One uncontrollable judge beside two controllable ones is what makes
  the difference visible, and gives M6 something to measure.
  The seed writes each judge's `model_pin`, calls `validatePin`, stores
  `model_pin_validation`, and **fails the whole seed** when a non-`fake:` pin does not route.
- `.env.example` — an `M1` section: `OPENROUTER_API_KEY`, `SEED_MODEL_A/B/C`, each with the
  reasoning the file's other entries carry.
- `README.md` — the fresh-clone walkthrough stays free and offline; a short section says what
  setting the three variables plus a key changes, and what it costs (~$0.005 a panel run).

- [x] `bun run db:seed` with no key set produces four `fake:deterministic` judges, each with
      the default pin, and makes **zero** HTTP calls
- [x] With a key and the three models set, it produces four pinned judges, each with a
      recorded `available_endpoints`, and prints them
- [x] The Gemini judge's pin carries a concrete effort literal equal to that model's
      `reasoning.default_effort` as read on the day it was seeded — **not** an absent field —
      and the value is recorded in this plan's deviations, so a later provider-side change to
      that default is a visible divergence rather than a silent one
- [x] It is still idempotent — a second run changes nothing and does not re-validate
- [x] Seeding a model whose pin cannot route **fails loudly**, naming the judge
- [x] `NODE_ENV=production` without `OPENROUTER_API_KEY` fails at boot naming the field
- [x] CI's `stack` job is untouched and still free: compose runs `NODE_ENV=development` with
      fake models, so k6 costs nothing

**Automated verification**
```bash
bun run db:setup && bun test && bun run lint && bun run typecheck
```
```bash
docker compose -f infra/docker-compose.yml up -d --wait && \
  curl -fsS -XPOST localhost:3000/v1/panels/pnl_000000000000000000SEEDPANE/evaluate \
  -H 'authorization: Bearer llk_test_'"$(printf '0%.0s' {1..64})" \
  -H 'content-type: application/json' -d '{"artifact":"Login button does nothing."}'
```

**Manual verification**
- Export a real key and the three models, re-seed, curl the panel: three different labs
  answer one request, `served_by` shows three dated ids, and the trace rows carry three
  different real costs. **This is M1's demo moment.**
- Confirm the Gemini judge's reasoning tokens are non-zero and the Sonnet judge's are zero —
  the pinned-versus-mandatory distinction, visible in data.

---

## Appendix (NOT M1) — banked CD phase, for whoever plans M8
> **This is no longer part of this plan.** CD moved to M8 on 2026-08-29 (see the Goal). It
> is kept here rather than deleted or parked because the reasoning is settled — D9 of the
> source research, STACK_DECISIONS D10 as amended — and re-deriving it in six milestones'
> time would be waste. **Do not implement from this section**; it is research banked for a
> future plan, not a reviewed phase. When M8 is planned, the investigation task below is the
> first thing to do and the stakeholder actions are the gate. One thing will have gone stale
> by then and should be re-checked rather than trusted: the Railway plan, its pricing, and
> its config-as-code surface.

**Slice goal:** the digest CI built, booted and k6'd is the digest that runs in production,
and something automated proves it (ADR-0011, D9).

Files:
- `.github/workflows/ci.yml` — a new `publish` job, `needs: [quality, stack]`, `if:
  github.event_name == 'push'`, `permissions: {contents: read, packages: write}`. It logs
  into `ghcr.io`, pushes both images under the **SHA and the release version**, never
  `latest` — the existing "refuse a `latest` tag" assertion stays and now guards a registry.
  The `web` image is built a **second** time with the production `VITE_API_URL`, because Vite
  inlines it at build time and ADR-0020 rules out reverse-proxying the origins together.
- `.github/workflows/deploy.yml` (new) — pins Railway's services to the freshly pushed SHA
  tag, waits, then runs the acceptance test: `curl $LIVE_API_URL/healthz` and assert
  `version` and `git_sha` equal the deployed commit. **That check is the deploy's whole
  point** — it is the only thing that proves what is actually running.
- `infra/railway/README.md` (new) — the service graph as documentation, mirroring compose
  rather than inventing a topology:

  | Service | Source | Notes |
  |---|---|---|
  | `postgres` | `postgres:18.6` + volume | Ours, not the managed add-on (ADR-0013) |
  | `migrate` | The API image, `bun run db:setup` | `restartPolicyType: NEVER`; holds all three connection strings |
  | `api` | The API image, `healthcheckPath: /readyz` | Holds **only** `DATABASE_URL` |
  | `web` | The web image | Built against the production API URL |

  - **Ordering falls out of a property that already exists.** Railway has no equivalent of
    compose's `depends_on: service_completed_successfully`, but `/readyz` checks migration
    currency and 503s when behind — so the healthcheck holds the deploy until migrations land.
  - **`preDeployCommand` on `api` is rejected**, even though it is the Railway idiom: it would
    hand the API container the migrator credential and destroy the privilege split `server.ts`
    is explicit about. A separate one-shot keeps compose's split exactly.
  - Config the deploy sets: `DATABASE_URL`, `APP_VERSION`, `GIT_SHA`, `BETTER_AUTH_SECRET`,
    `API_BASE_URL`, `WEB_ORIGIN`, `OPENROUTER_API_KEY`, `SEED_MODEL_A/B/C`, plus whatever
    M2–M7 have added to `config.ts` by then — that list is a snapshot of 2026-08-29, not a
    contract.
    `OTEL_EXPORTER_OTLP_ENDPOINT` is **deliberately unset** — the Grafana stack is
    compose-only and shipping it is M3; unset is a supported state, so the tracer still runs
    and `request_id` is still a real W3C trace id.
- `README.md` — the live URL, and a one-line "what is deployed" pointer.

- [ ] **Investigation task, first:** confirm how Railway is told to use a new image tag.
      Config-as-code does not appear to carry an image source, so this is likely a CLI or API
      call per deploy. Verify against the real project before writing `deploy.yml`; if it
      turns out to need a manual gesture, the first deploy is manual and the workflow is
      scoped to the smoke test. **See open question 1.**
- [ ] Both images appear in GHCR, private, under two immutable tags each
- [ ] Railway pulls from GHCR with a registry credential (no `railway up`, which would rebuild
      and break the "same artifact" chain)
- [ ] `migrate` runs to completion once and does not restart-loop
- [ ] `api` becomes healthy only after migrations land, proven by watching a deploy where the
      migration is slow
- [ ] The live `/healthz` reports the version and SHA of the commit that triggered the deploy
- [ ] The live console loads and can log in — real CORS across two real origins (ADR-0020)
- [ ] A curl against the live panel with the seeded key returns three real verdicts
- [ ] `apps/api` in production still holds only `DATABASE_URL`, verified from the Railway
      variable list rather than assumed

**Automated verification**
```bash
gh workflow run ci.yml && gh run watch
```
```bash
curl -fsS "$LIVE_API_URL/healthz" | jq -e --arg s "$(git rev-parse HEAD)" '.data.git_sha == $s'
```

**Manual verification**
- Merge a trivial commit and watch it reach the live URL unattended.
- Break something deliberately (a bad `DATABASE_URL` on `migrate`) and confirm the deploy
  fails rather than half-succeeding.
- **Stakeholder actions, up front:** Railway Pro on the workspace ($20/mo, includes $20 usage
  credit); the Railway project and four services; `RAILWAY_TOKEN` in GitHub secrets; an
  OpenRouter key with credit set as a Railway variable.

---

## Decisions made
Every line here is a choice this plan embeds that is not already an accepted ADR. `/approve_plan`
turns them into ADR stubs.

1. **The pin type lives in `packages/contracts`, not `apps/api`.** It is written to a column
   ADR-0003 freezes and becomes an API surface at M4's picker; type truth is contracts'
   whole job.
2. **`quantizations` is optional; omitted means unconstrained.** Proprietary hosted routes
   (Claude, GPT, Gemini) have no quantization variance, so naming one there is a constraint
   with nothing to bind. It binds where it is written, which is the open-weights case
   ADR-0022/D4 was actually about. *(Settles research open item 3.)*
3. **Creation-time validation is one ordinary `evaluate()` call, not a new port method.**
   `ProviderResult` gains `availableEndpoints?` instead. The port's documented design is one
   method; a second verb would be owed by every adapter forever, to serve one caller.
4. **The validation result gets its own `model_pin_validation` column.** The pin is a
   constraint translated onto the wire; the count is a measurement taken once. Merging them
   would put non-request data into the request body. ADR-0022 mandates recording the count and
   does not say where; this is where. **Confirmed by the stakeholder, 2026-08-29.**
5. **`misconfigured` also covers non-moderation 400s**, extending D6's 401/402. A request the
   provider calls malformed never self-heals, retrying is the same answer twice, and it is our
   bug — which is precisely the three properties that defined the kind.
6. **503 "no endpoint matches routing" maps to `unavailable`** and is therefore retried and can
   trip the breaker. Call time cannot distinguish a transient empty pool from a permanently
   unsatisfiable pin; creation-time validation is the mitigation, and this is the cost of not
   having one at call time.
7. **The adapter takes an injected `fetch`.** The shared contract suite then runs offline and
   deterministically, and there is no network test that silently skips — the same reasoning
   CI already applies to the Postgres tests it refuses to skip.
8. **Live verification is a script and the seed's own validation, never a skipping test.**
   `bun run verify:pin` costs money and needs a secret; a test that quietly passes when
   neither is present would report a green suite that proved nothing.
9. **`cost_usd` is `numeric`, not `real`.** It is money, M2's metering sums it, and float4
   loses the cents-of-a-cent precision `cost.ts` already rounds to.
10. **`costOf` prefers the provider's figure and reports `priced: true` only when it has one**;
    `MODEL_PRICES` shrinks to the `fake:` entry rather than growing (D8).
11. **`OPENROUTER_API_KEY` is optional in dev/test and required in production**, via the same
    `superRefine` that rejects the committed auth secret. Zero-secret boot survives; a
    production deploy that forgets the key fails at boot rather than at the first judge call.
12. **The seed validates every non-`fake:` pin and fails outright when one does not route** —
    which couples compose's `migrate` one-shot — and later any deploy that inherits it — to
    OpenRouter's availability. Accepted: a judge
    with an unsatisfiable pin is permanently broken (ADR-0022), and a deploy that refuses is
    better than a panel that 503s per call. **Confirmed by the stakeholder, 2026-08-29: there
    is no switch.** A safety check with an escape hatch is a safety check that dies the first
    busy afternoon, and the failure it catches — a judge frozen against a pin that routes
    nowhere — is permanent by construction.
13. **Every `llm` judge carries a pin, `fake:` ones included**, so the CHECK is ADR-0022's clean
    mirror rather than a route-conditional rule. The fake's pin records `data_collection: 'deny'`
    like every other row — redundant by design, which is what makes a future exception auditable.
14. **The per-attempt timeout is re-derived from measurement, not inherited.** 10s was chosen
    against a fake; M2's k6 baseline will inherit whatever P2 writes down, so it is measured
    against a real frontier call on a large artifact first.
15. **Reasoning tokens use a `labelloop.`-namespaced span attribute.** No OTel convention names
    them, and `attributes.ts` states the rule: ours are namespaced so a later convention cannot
    collide.
16. **Prefix dispatch through a small registry in `llm/`**, with an unknown prefix throwing
    `unavailable` — so the composite itself satisfies the shared contract suite's
    `unknownModel` case rather than being exempt from it.
17. **`google/gemini-3.7-flash` is pinned to its own default effort — as a literal.**
    Stakeholder call, 2026-08-29: use the model's default rather than choosing a cheaper one
    for it. Its reasoning is `mandatory: true`, so `none` is a hard 400 and something had to be
    chosen. **What "use the default" means here is load-bearing:** P5 reads
    `reasoning.default_effort` off the models API once and writes that *concrete value* into
    the pin. It does not mean omitting the field and letting OpenRouter decide — that would
    make a frozen `jdv_` silently re-mean itself the day the provider moved its default, which
    is the defect ADR-0022 was written against. If the provider later changes its default, ours
    does not move, and the divergence is visible instead of invisible.
18. **Five phases, one branch and one PR each**, per CLAUDE.md's one-branch-per-phase rule.
19. **CD leaves M1 for M8**, and BUILD_SPINE is amended rather than quietly diverged from —
    it is the single ordering authority, so a plan that contradicted it would make it stop
    being one. The accepted cost of deploying late is written into M1's note, not left to be
    discovered.

*Banked for M8, recorded so it is not re-derived:* publishing is a separate CI job gated on
`stack` and on `push: main`, and the live `/healthz` provenance check is the deploy's
acceptance test — nothing reaches the registry that has not already been composed, migrated,
seeded and k6'd.

## Deviations
Recorded as they happened; these are decision provenance too.

1. **`OPENROUTER_API_KEY` moved from P5 to P2 (`config.ts`).** P2's `server.ts` change
   registers the adapter "only when a key is present", which requires reading it. P5 still
   owns making it **required in production** via the `superRefine`.
2. **`@openrouter/sdk` adopted for response decoding — a new dependency the plan said it
   would not introduce.** Stakeholder decision, 2026-08-30, recorded as **ADR-0030** and
   **STACK_DECISIONS D16**. The plan's "no new npm dependency is introduced at all" was an
   observation about this plan's expected shape, not a policy — CONVENTIONS' bar is limited
   dependencies, never zero — so this is a plan-scoped deviation and not a rule being
   broken. The reason it was worth taking: the hand-written
   `OpenRouterResponse` had already produced a real bug. `served_by` read
   `available[0].model` where the endpoint that actually answered is the one flagged
   `selected` — a plausible wrong answer in the field ADR-0022 says routing-drift queries
   depend on. Their transport was inspected and deliberately NOT adopted (one-hour retry
   ceiling, jitter added on a deterministic base, no breaker), so ADR-0012 stands intact.
3. **The import fence was narrowed to bare specifiers.** Adding `openrouter` to the
   provider-SDK regex made it fire on `server.ts` importing our own
   `./llm/openrouter-provider.ts`. `(?!\.)` restricts the rule to third-party packages,
   which is what it was always about; verified to still catch a planted
   `@openrouter/sdk` import in `services/`.

4. **The per-attempt timeout was re-derived and the measurement CONFIRMED 10s (Decision 14).**
   Measured 2026-08-30
   with `verify:pin` against a ~2,700-input-token artifact, three real models, a real key:

   | Model | Effort | Latency | Endpoints | Cost | Reasoning tokens |
   |---|---|---|---|---|---|
   | `anthropic/claude-sonnet-5` | none | 5304 / 3829 / 4092 ms | **5** | $0.007244 | 0 |
   | `google/gemini-3.7-flash` | **medium** | 2337 ms | 2 | $0.002115 | **84** |
   | `openai/gpt-5.6-sol` | none | 1877 ms | 3 | $0.005366 | 0 |

   The value does not move, and that is the honest outcome rather than a missed change: it
   is now evidenced instead of inherited from a number chosen against a fake. Two
   constraints bracket it. From below, the slowest observed call at 5304ms, cleared with
   1.9x headroom — and erring high matters because the failure modes are asymmetric: too
   high costs one slow request, too low KILLS calls that would have succeeded and pays for
   them again. From above, `retry.test.ts` caps the caller's worst case
   (`maxAttempts * timeoutMs` + backoff) at 31s, which at three attempts puts the ceiling
   at **10.23s**. 10s is very nearly the largest value that budget permits.

   **Corrected the same day, and the correction matters more than the number.** A sweep of
   the cheap tier caught `anthropic/claude-haiku-4.5` at **15092ms** on the same probe
   (3078 / 5839 / 15092 across three runs) — half again the timeout, on the model advertised
   as the fast one. So "1.9x headroom" was an artefact of sampling three frontier models:
   latency varies far more ACROSS the catalogue than within one model, and three samples of
   one model do not bound it. The value still does not move, because the caller-latency
   budget is what fixes it, but the justification is now the budget rather than a headroom
   claim the data does not support. A slow model is expected to time out and be retried.

   Worth recording as process: an initial 12s was written and the budget test rejected it.
   That test encodes a product commitment about what a caller waits, so the right response
   was to accept the constraint rather than raise the bound to fit a number picked by feel.
   Going above 10s is not tuning — it means renegotiating that budget or spending a retry
   attempt, and nothing measured here justifies either. M2's k6 work should replace three
   samples with a distribution.

   Three things the live run confirmed that no stub could:
   - Sonnet's pin leaves **5 endpoints**, matching ADR-0023's independently measured "5 of 9".
   - Key order was correct on all three, and `served_by` returned the DATED id via
     `selected` — the field the vendor types surfaced (ADR-0030).
   - Gemini's reasoning tokens are **84** while the other two are 0 — the
     pinned-versus-mandatory distinction, visible in data, which P5's manual verification
     asks for and which is now confirmed ahead of it.

5. **`google/gemini-3.7-flash` has `reasoning.default_effort: "medium"`**, read from the
   models API on **2026-08-30**. That is the literal Decision 17 requires P5 to write into
   its pin — not an absent field. Recorded here so a later provider-side change to that
   default is a visible divergence rather than a silent one. Confirmed the hard way first:
   at effort `none` the model returns a 400, *"Reasoning is mandatory for this endpoint and
   cannot be disabled"*, which the adapter classified as **`misconfigured`** and did not
   retry — the failure table's 400-without-moderation row, exercised live.

6. **The Drizzle driver moved to `node-postgres` mid-phase (ADR-0031).** Not planned work,
   and taken deliberately: the double-encoding defect the M0 `jsonbColumn` workaround was
   written against recurred in P4's brand-new `model_pin`, written while documenting the
   warning. `${JSON.stringify(pin)}::jsonb` stored a jsonb STRING and nothing complained,
   because the CHECK only asks whether the column is null; it would have surfaced at M4 as
   a picker unable to read back the pin it had just written. Probed both drivers against a
   real database — under `pg` both spellings are correct, so the bug is unrepresentable
   rather than merely fixed. `jsonbColumn` is deleted, SQLSTATE moved from `.errno` to
   `.code`, and queries are eager rather than lazy. Stakeholder decision, 2026-08-30.

7. **`RATIONALE_MAX_LENGTH` was split into a target and a bound, and the limit is now stated
   in the prompt. P5 could not be completed without it.** Not P5's scope — it is P2's
   `judge-schema.ts` and `openrouter-provider.ts` — but the seed cannot validate a real pin
   while the flagship model fails validation, so it is a prerequisite rather than a
   digression.

   The defect: 280 was sent as `maxLength` under `strict: true`, **never mentioned in the
   prompt**, and enforced by rejecting the parse. Structured output does not constrain
   string length — providers constrain shape — so the cap was advisory on the wire and
   absolute on the way back. Measured 2026-08-30 on an identical probe:

   | Model | Validated | Rationale lengths |
   |---|---|---|
   | `anthropic/claude-sonnet-5` | **1 / 5** | 296, 292, 274, 331, 384 |
   | `openai/gpt-5.6-sol` | 5 / 5 | 175, 153, 202, 171, 239 |
   | `google/gemini-3.7-flash` | 5 / 5 | 138, 153, 131, 111, 129 |

   A model was never told the limit and was then refused for exceeding it. The fix is two
   changes: `RATIONALE_TARGET_LENGTH` (280) is stated in the system message, and
   `RATIONALE_MAX_LENGTH` (1000) is the outer bound that rejects an essay rather than a long
   sentence. **The instruction did nearly all the work** — re-measured 2026-08-31, Sonnet
   returned 134-158 and passed 5 of 5, and `claude-haiku-4.5`, which deviation 4 recorded at
   ~570 characters on 4 of 4 probes, returned 185-296 and passed 5 of 5. The raised bound is
   a margin, not the mechanism.

   Why raising the bound rather than truncating: the failure modes are asymmetric. Too high
   costs a few dozen tokens on one response; too low DISCARDS a correct verdict — reasoning,
   taxonomy codes and answer all fine, thrown away over prose length — and bills for it again
   on the retry. Truncation was rejected because a stored rationale that is not what the model
   said breaks "raw provider payloads stored alongside normalized fields".

   **Timing is not incidental.** ADR-0033 makes the prompt scaffold immutable once a judge
   freezes against it. M1 has no production tenant and no real customer judges, so this is the
   last moment the change is free; after M4 the same fix is a new template version.

8. **A misnamed test was corrected rather than renumbered.**
   `validate-pin.test.ts` carried "a model that answers OUT OF ORDER fails validation — the
   live Haiku case", whose fixture was a 600-character rationale — over-length, not
   out-of-order. Ordering is properly covered in `judge-schema.test.ts`. It is now two honest
   tests: a rationale between the target and the bound VALIDATES (the regression guard for
   deviation 7), and an essay above the bound still fails. `judge-schema.test.ts` now asserts
   `maxLength` against the exported constant rather than a literal `280`, since a literal is
   what let the wire schema and the parser drift apart.

9. **`scripts/` was typechecked by nothing, and now is.** No workspace `tsconfig` covered it,
   which was tolerable while the scripts were connection strings and INSERTs and stopped
   being so when `seed-judges.ts` began deciding which model each judge is frozen against.
   `tsconfig.scripts.json` is added and `bun run typecheck` runs it after the packages; it
   immediately caught two real type errors in the new tests.

10. **Compose now forwards `OPENROUTER_API_KEY` and `SEED_MODEL_A/B/C`.** Not in P5's file
    list, and caught only because the README section written for P5 documented a path that
    did not work: it said setting a key and three variables "swaps in three real frontier
    models", while compose — the README's own one-command path — passed neither to the `api`
    nor the `migrate` service. The seed would have pinned real models and the API, holding no
    key, would have answered `unavailable` on every one of them.

    The plan's "CI's `stack` job is untouched and still free" is about CI staying free, not
    about compose being off limits, and a passthrough that is absent when unset keeps it
    exactly as free — verified below.

    **The spelling is load-bearing.** `OPENROUTER_API_KEY:` (map-null) resolves from the host
    and omits the variable when unset; `${OPENROUTER_API_KEY:-}` resolves to the EMPTY
    STRING, which `z.string().min(1).optional()` rejects — so the tidier form would make
    every zero-secret `docker compose up` fail at boot naming the field. Proved both ways in
    a real container before committing to it.

    Verified end to end on an isolated compose project (`-p ll-verify`, own ports and image
    tag, so the running dev stack was never touched): with the four exported, the migrate
    one-shot pinned three real models and a curl through the composed API returned three
    dated `served_by` ids; with none exported, the seed produced four `fake:deterministic`
    judges and the API logged `"routes":["fake"]`. **A stale image nearly hid the first
    result** — `up` without `--build` reused the existing `labelloop-api:dev`, so the first
    run exercised the old seed and printed the old output. Hence `--build` in the README.

    The README also now says to `down -v` first: the seed is idempotent by judge id and a
    `jdv_` is immutable, so a judge already seeded as `fake:deterministic` stays fake no
    matter what is exported. That is ADR-0003 working, and it is the kind of thing that
    reads as a broken feature if it is not written down.

## Explicitly NOT doing
- **Streaming, in all three of its senses (D5).** Into the adapter it costs the two things M1
  exists to harden — error mapping (mid-stream failures arrive inside a 200) and cost
  accounting (`usage` lands only in the final chunk). Out of the API it is close to
  disqualified on the contract's own terms: `aggregate()` normalises weights across the judges
  that *actually scored*, so every judge that lands changes the denominator of everything
  already emitted; there is no correct partial `Evaluation`. Revisit at M2 with real latency data.
- **A model catalogue or capability-gated picker (D8).** All three consumers evaporate: the
  picker is M4, capability *enforcement* is `require_parameters`, and cost now comes from
  `usage.cost`. The catalogue is a menu, not a record — the record is the frozen pin — so
  freshness is a UX property, never a correctness one.
- **Honouring `Retry-After` on a 429, and any per-key rate limiting.** M2.
- **A scheduled `GET /api/v1/key` balance check.** M3, and its response shape wants confirming
  against a real key first (D6).
- **Changing the published error contract for refusals.** They stay `invalid_output` →
  `failed`, distinguished in `raw_response` and the console rather than in the message (D7).
  M5/M6 will supply real cases — the showcase tenant candidate is a prompt-injection judge with
  an adversarial eval set, i.e. the judge most likely to trip moderation.
- **Confidence calibration.** Named in the research as an M6 deliverable, and a measurable
  claim worth a negative result; not an M1 change.
- **A second provider, a direct first-party adapter, or BYOK.** ADR-0021's expiry condition
  fires before a tenant that is not us sends artifacts — M5's dogfooding tenant is still us.
- **A judge-creation API or console surface for pins.** M4. M1 seeds by script, which is
  exactly what the BUILD_SPINE line says.
- **The `code` judge executor.** Still `failed` with an honest message, until the taxonomy
  triage at M5/M6.
- **Deploying anything.** GHCR, Railway and the live URL are M8 now, and nothing is built,
  configured or paid for here. CI keeps building and composing images exactly as it does
  today, and keeps not pushing them anywhere. Everything through M7 runs on compose.
- **Runtime configuration for the SPA.** The console image is built twice because
  `VITE_API_URL` is a build arg. Runtime config is the correct fix and is parked; making the
  origins match by reverse-proxying is ruled out by ADR-0020.
- **Public images.** Free, and defensible given the repo is public and the images boot with no
  baked secrets — the stakeholder chose private, which is what makes Railway Pro necessary.

## Settled in review — 2026-08-29
All three open questions were answered by the stakeholder; each is folded into the Decisions
above, and **none remains blocking.**

1. **`model_pin_validation` as its own frozen column — confirmed.** The pin stays a pure
   constraint; the endpoint count stays a measurement. (Decision 4.)
2. **No switch on the seed's pin validation — confirmed.** `db:setup` fails when a non-`fake:`
   pin does not route, and there is no `SEED_VALIDATE_PINS` escape hatch. (Decision 12.)
3. **Gemini uses its own default reasoning effort**, written into the pin as a concrete literal
   read from `reasoning.default_effort` — never as an absent field. (Decision 17.)

**A real `OPENROUTER_API_KEY` is present in the repo's gitignored `.env`** (confirmed
2026-08-29: ignored at `.gitignore:3`, untracked). So P2's `verify:pin`, its timeout
re-derivation, and P5's real-model seed are all runnable during implementation rather than
deferred — M1 gets proven against the actual API, not only against a stubbed `fetch`. Two
standing constraints follow: the key is read from the environment and never written into a
plan, a test fixture, a log line or a commit; and P2's live measurements cost real money, so
they are run deliberately, not in a loop.

## Carried to M8 with the appendix — not questions for this plan
- **How is Railway told to deploy a new image tag?** The one item the research left genuinely
  open. Config-as-code does not appear to carry an image source, so it is likely a CLI or API
  call per deploy. The fallback, if it needs a manual gesture: first deploy by hand,
  `deploy.yml` scoped to the live `/healthz` smoke — which is the check that matters regardless.
- **Does D9's CD topology get its own ADR-0024?** It commits to a paid plan and defines the
  production service graph, and "how do you deploy" is a certain interview question. Currently
  it lives in the decisions log and STACK_DECISIONS D10 only.
- **Stakeholder actions, whenever M8's deploy is picked up:** Railway Pro on the workspace;
  the project and its four services; `RAILWAY_TOKEN` in GitHub secrets; an OpenRouter key with
  credit. **An OpenRouter key is still wanted at M1** — not for a deploy, but so P2's
  `verify:pin` and P5's real-model seed can be run by hand; without one, M1 lands proven only
  against a stubbed `fetch`.
