---
date: 2026-08-28T00:00:00Z
author: claude-code
status: draft
milestone: M1
topic: m1-endpoint-spine
related_adrs: [0001, 0003, 0009, 0011, 0012, 0013, 0016, 0019, 0020, 0021, 0022, 0023]
reviewed: 2026-08-28 — all seven open questions walked through with the stakeholder and
  settled; see "Decisions taken in review". D1/D3/D4 are now **ADR-0022**, D2 is now
  **ADR-0023**, and all of them are in thoughts/shared/progress/decisions-log.md (2026-08-29).
  Subsequently validated with a real key — see "Verified with a live key" — which closed two
  open items and produced one new decision (D11, reasoning control).
---

# M1 endpoint spine — OpenRouter behind the port, capability gating, cost, and CD

## Problem summary
M0 shipped every pattern the endpoint spine needs and one fake behind them. M1 must
replace the fake with an OpenRouter adapter (ADR-0021 / D15), persist tokens and cost on
the trace (which no column currently holds), and deploy the whole container story to a
live URL. The hard part is not the HTTP call: ADR-0021 explicitly routed one question here
unanswered — **what `judge_versions.model` must contain**, given that the *access path*,
not just the model name, determines whether structured output is even available, and
ADR-0003 freezes whatever is written there forever.

## Relevant files and why each matters
- `apps/api/src/llm/provider.port.ts` — the port M1 implements. One method, no streaming
  by explicit design; `JudgeCall.model` is an opaque namespaced string; `servedBy` was
  written for exactly this adapter and is currently unused.
- `apps/api/src/llm/index.ts` — the gateway. Keys the **circuit breaker by `call.model`**
  and calls `costOf(call.model, usage)`; `RETRYABLE` / `AFFECTS_HEALTH` / `TAXONOMY` are
  the three tables a new failure kind has to be added to.
- `apps/api/src/llm/cost.ts` — `MODEL_PRICES` hand-literal. Only `cost.ts` and its test
  reference it, so the blast radius is two files.
- `apps/api/src/llm/retry.ts` — `DEFAULT_RETRY_POLICY` = 3 attempts, 10s per-attempt
  timeout, full jitter. A real provider makes 10s a number to re-derive, not inherit.
- `apps/api/src/llm/provider.contract-test.ts` — the suite the new adapter must import
  rather than reimplement. Its `unknownModel` case demands `unavailable`, which for a
  network adapter means classifying OpenRouter's whole 4xx/5xx space.
- `apps/api/src/llm/fake-provider.ts` — `FAKE_MODEL = 'fake:deterministic'`, dispatching on
  the `fake:` **prefix**. The namespacing convention M1 extends already exists.
- `apps/api/src/services/evaluate.ts` — fan-out, polarity, aggregation, trace write. Needs
  no change for the provider swap; `toVerdictRows` is where token/cost columns land. Also
  the only place `INTERNAL` outcomes are forwarded to the error reporter, and it requires
  `cause` to be set.
- `packages/db/src/schema/judge-versions.ts` — the `model text` column plus the
  `judge_versions_model_matches_type` CHECK (`code` → NULL, `llm` → NOT NULL). The new pin
  column needs the mirror-image constraint.
- `packages/db/src/schema/trace-verdicts.ts` — has `served_by`, `latency_ms`, `attempts`,
  `raw_response` and **no token or cost columns at all**. M1's spine line requires them.
- `packages/contracts/src/evaluate.ts` — `judgeOutputSchema` is the structured-output
  schema, and its **property order is documented as load-bearing** (rationale → reasons →
  verdict → confidence). Zod 4 (`z.toJSONSchema`) can derive the provider schema from it.
- `apps/api/src/config.ts` — boot-time schema; `NODE_ENV=production` already *rejects*
  placeholder `APP_VERSION`/`GIT_SHA`/`BETTER_AUTH_SECRET`. `OPENROUTER_API_KEY` lands here.
- `apps/api/src/routes/health.ts` — `/readyz` checks DB, **migration currency**, and queue.
  The migration check is what sequences the Railway deploy (see Q6).
- `apps/api/src/server.ts:56` — the literal one line ADR-0021's swap is about.
- `apps/api/src/architecture.test.ts` — the fence. Needs `openrouter.ai` in the hostname
  regex; its `fetch(` ban means any catalogue client must also live in `src/llm/`.
- `infra/docker-compose.yml` — the `migrate` one-shot runs `db:setup` (bootstrap → migrate
  → seed) **from the API's own image** with different credentials, `restart: 'no'`, and is
  idempotent. This is the topology Railway mirrors.
- `.github/workflows/ci.yml` (`stack` job) — builds and SHA/version-tags images, boots
  compose, asserts `/healthz` provenance, runs k6. It **never pushes to a registry**.
- `apps/web/Dockerfile:49` — `VITE_API_URL` is baked at build time, so the console image is
  environment-specific.
- `scripts/seed.ts` — four judges (`is-bug`, `is-feature`, `is-question`, `needs-human`),
  all pinned to `fake:deterministic`. `needs-human` is the `required: true` veto judge.

## Existing patterns and constraints that apply
- **ADR-0016 / `architecture.test.ts`**: no provider SDK, hostname, or `fetch(` outside
  `apps/api/src/llm/`.
- **ADR-0012**: resilience is hand-rolled. No OpenAI SDK, no AI SDK, no LangChain — ADR-0021
  rejects the last two by name. Plain `fetch` to `/api/v1/chat/completions`.
- **CONVENTIONS "LLM-call rules"**: timeout → retry → breaker → cost, once, in `llm/`.
- **CONVENTIONS + ADR-0019**: reasoning before verdict, so JSON-schema key order is
  semantic rather than cosmetic.
- **ADR-0003**: `jdv_` rows are immutable and public contract. A judge re-run must be
  provably the same judge.
- **ADR-0011**: never `:latest`; SHA + version tags; `/healthz` reports both.
- **ADR-0009 + ADR-0013**: containers-first; Postgres is *our own container* everywhere.
- **ADR-0020**: nginx serves the console statically and is never a reverse proxy in front
  of the API, so real CORS stays under test.
- **CONVENTIONS "Logging"**: bodies are never logged; metadata, not content. This binds
  the moderation path (see Q4).

## What the OpenRouter surface actually looks like (verified 2026-08-28 against the live API)
- **Capability is per-endpoint; the model-level field is a union.** `GET /api/v1/models`
  (396 models, 312 advertising `structured_outputs`) is a menu.
  `GET /api/v1/models/{author}/{slug}/endpoints` is the truth: per endpoint it gives `tag`,
  `provider_name`, `supported_parameters`, `pricing`, `context_length`,
  `max_completion_tokens`, **`quantization`**, and uptime. Measured on the models we intend
  to seed: `anthropic/claude-sonnet-5` has 9 endpoints of which **3 fail** (all Google
  Vertex regions lack structured output); `openai/gpt-5.6-sol` has 7 of which **1 fails**
  (Amazon Bedrock); `google/gemini-3.7-flash` has 6 and **all pass**.
- **There is no data-policy field on the endpoints or providers API.** The providers API
  gives a `privacy_policy_url` — a link for a human, not a flag for a picker. So
  `data_collection: 'deny'` is enforceable only at request time, invisibly, and its effect
  on pool size cannot be predicted from the catalogue.
- **Quantization varies per endpoint for open-weights models.** `z-ai/glm-5.3` is served at
  `fp4`, `fp8` and `bf16` across sixteen hosts at overlapping prices. The same model at two
  quantizations is not the same judge. Proprietary hosted models (Claude, GPT, Gemini) have
  no such variance.
- **Request-side controls**: `provider: { require_parameters, data_collection, quantizations,
  only, order, allow_fallbacks, sort, max_price }`. `require_parameters: true` means "route
  only to endpoints supporting every parameter I sent" — since we always send
  `response_format`, that one flag is the capability enforcement.
- **Cost comes back per call.** `usage` is always present and carries `cost` and
  `cost_details.upstream_inference_cost`. The `usage: {include: true}` opt-in is deprecated.
- **Which endpoint served is opt-in.** The response's `model` names the model, not the path.
  `openrouter_metadata` (header `X-OpenRouter-Metadata: enabled`) carries `requested`,
  `strategy`, `endpoints`, `is_byok`, `attempt`.
- **Errors**: 400 invalid params / moderation (`error.metadata.reasons`, `flagged_input`),
  401 bad key, 402 out of credits, 403 guardrail, 408 timeout, 429 + `Retry-After`,
  502 model down, 503 no endpoint matches routing. Mid-stream errors arrive inside a 200
  with `finish_reason: "error"`. `GET /api/v1/key` returns the key's limit and usage.

## Verified with a live key (2026-08-29)
Three real judge calls, one per seed model, sending the actual `judgeOutputSchema` under the
full pin (`require_parameters: true`, `data_collection: 'deny'`) with routing metadata enabled.

- **`usage.cost` is denominated 1:1 in USD.** Confirmed arithmetically on all three: Sonnet 5's
  368 input × $2/M + 155 output × $10/M = $0.002286, exactly the reported figure. `cost_details`
  decomposes it into prompt and completion. **Closes what was open item 2.**
- **Key order was correct on all three.** The reasoning-before-verdict guarantee holds in
  practice. The raw-text assertion still ships — this proves three models today, not every model
  forever.
- **The pin narrows the pool, measurably.** `openrouter_metadata` reports availability:
  Sonnet 5 **5 of 9**, `gpt-5.6-sol` **1 of 5**, `gemini-3.7-flash` **2 of 2**. Sonnet lost four
  where the capability gate alone predicted three, so `deny` cost one extra endpoint — the first
  direct measurement of the invariant's price. **`gpt-5.6-sol` has no failover under the pin.**
- **`openrouter_metadata.endpoints.available[].model` returns the DATED id**
  (`anthropic/claude-sonnet-5-20260630`) where `response.model` returns only the alias. The dated
  snapshot is the better `served_by` value — it is the identity that actually answered.
- **Measured cost per call**, small artifact: Sonnet 5 $0.0023 · sol $0.0012 · Gemini Flash
  $0.00098. ADR-0023's $0.008 estimate assumed a 2,000-token artifact and is conservative by ~4x
  at this size.
- **Reasoning is structured, queryable data** on the model object:
  `{mandatory, default_enabled, supported_efforts, default_effort}`. **83 of 396 models have
  `mandatory: true`**, including `google/gemini-3.7-flash` and `z-ai/glm-5.3`. Disabling it on a
  mandatory model is a hard `400`. All three seed models carry `default_enabled: true`, with
  differing default efforts ("high" for Sonnet, "medium" for sol) — so silence means each judge
  reasons by a different amount.

## Decisions taken in review (2026-08-28)

**D1 — `judge_versions.model` pins a capability contract, not an endpoint identity.** *(ADR-0022)*
Two frozen columns: `model` as a route-qualified string (`openrouter:anthropic/claude-sonnet-5`,
extending the existing `fake:` convention so adapter selection is prefix dispatch and M7's
`finetune:` is additive), plus **`model_pin` jsonb** carrying the constraints. The pin
describes *properties an endpoint must have*, not *which endpoint* — so it survives
catalogue churn and still permits failover among equivalent endpoints, while guaranteeing
the property the judge actually needs. Endpoint identity is recorded per call in
`served_by` from `openrouter_metadata`, making drift a query rather than an assumption.
Rejected: bare model id (can't distinguish a future direct adapter), endpoint pinned into
the string (an ad-hoc grammar that can't grow on frozen rows), hard endpoint pin (buys
reproducibility, destroys failover — one upstream's uptime becomes the judge's).
*Settled:* the **breaker key stays the model string, not model+pin** — judges sharing a
model share upstream capacity, OpenRouter's internal failover is invisible to us, so the
circuit should trip only when the whole permitted pool is gone.

**D2 — `data_collection: 'deny'` is fixed, and written into every pin as a value.** *(ADR-0023)*
One writable value at M1; no UI toggle. Rationale: adding a second value later is additive
(every row already records what it was, so populations stay distinguishable), whereas
removing a toggle later is a migration plus an audit. The cost is real but small — roughly
$0.008 per judge call, ~5¢ per six-judge panel evaluation — and the endpoints `deny`
excludes are disproportionately free tiers, which are also the weakest models and therefore
useless as M7's frontier baseline. Revisit trigger is a **concrete** case: a model you want
returning 503 at creation-time validation.

**D3 — Pins are validated by one real call before the `jdv_` is frozen.** *(ADR-0022)*
Not a privacy attestation — we cannot certify a data policy and must not imply one. It
proves three things nothing static can: that the pin is *satisfiable* (an empty routing pool
is a 503), **how many endpoints survive it** — a judge at `available=1` is fragile in a way one
at `available=5` is not, and that is knowable at the one moment the pin can still change — and
that the model genuinely honours the schema **in the required key order**
rather than treating it as a hint. Creation time specifically, because immutability makes it
the last moment the pin can change. A permanent broken judge becomes a form error.

**D4 — Quantization belongs in the pin.** *(ADR-0022)* Raised by the GLM data above. A judge pinned to
an open-weights model can be served at fp4 one week and bf16 the next, at the same price.
M6 measures agreement *per `jdv_` version*; an unexplained swing between runs of a frozen
version would send someone hunting for drift that was actually a routing change. This is the
same class of defect as the structured-output gap, and the fix is the same: pin the model
*as executed*, via OpenRouter's `quantizations` filter.

**D5 — No streaming at M1, in any of its three senses.** (a) Streaming into the adapter
buys liveness — distinguishing a slow model from a hung one inside the 10s per-attempt
timeout — but costs the two things M1 exists to harden: error mapping (mid-stream failures
arrive inside a 200) and cost accounting (`usage` only lands in the final chunk). Revisit at
M2 with real latency data. (b) Streaming out of the API is close to disqualified on the
contract's own terms: `aggregate()` normalises weights across the judges that *actually
scored*, so every judge that lands changes the denominator of everything already emitted —
there is no correct partial `Evaluation`. It also fights ADR-0002/D5 (no SDK ⇒ the caller
hand-parses SSE) and doesn't curl or render in Scalar, which is M1's demo moment.
(c) Console streaming is an M4/M5 surface question, untouched here.
*Noted for M6, not M1:* `confidence` is self-reported and uncalibrated, and the contract has
it driving low-confidence sampling at M5. Whether a judge saying 0.55 is actually likelier to
be wrong than one saying 0.95 is a measurable claim, and checking it honestly — including a
negative result — is the kind of failure analysis CLAUDE.md treats as a deliverable.

**D6 — A fourth `ProviderFailureKind`: `misconfigured`.** 401 (bad key) and 402 (out of
credits) currently fall into `unavailable`, which retries three times, trips a per-model
circuit whose half-open probe can never succeed, and returns `PROVIDER_UNAVAILABLE` with a
`Retry-After` — telling the customer to retry something that cannot succeed. The new kind is
`RETRYABLE: false`, `AFFECTS_HEALTH: false` (nothing for a probe to recover), maps to the
existing **`INTERNAL`** code so no contracts change is needed, and must set `cause` so
`evaluate.ts` forwards it to Sentry. Logged at **`error`**, not `warn` — CONVENTIONS defines
`error` as alert-worthy, and this never self-heals and takes every judge down at once. Gets
its own `failure_kind` span attribute so M3 dashboards don't conflate "OpenRouter is flaky"
with "we didn't pay the bill"; it is the strongest candidate for M3's "one alert rule".
**Not surfaced on `/readyz`** — readiness asks "should traffic be sent here", and the console
and trace explorer are fine; marking unready would pull the instance and, on Railway, produce
a restart loop over a condition no restart fixes. Rejected: throwing a plain non-`ProviderError`
to get no-retry + Sentry for free — it works, and it routes a known condition through the
port's documented bug path.
*Optional, M3 not M1:* a scheduled `GET /api/v1/key` check to warn on a balance threshold
rather than at zero. Response shape needs confirming against a real key first.

**D7 — Refusals stay `invalid_output`, and are distinguished in the record rather than the
message.** Promoting them to `error` to get a branchable code would break the contract's
careful split, because `error` means *the call did not complete* and a refusal completed.
**Content-safety finding:** `error.metadata.flagged_input` echoes up to 100 characters of the
customer's artifact. Error paths are exactly where this design keeps content out, so that
payload must never reach a log line, a span, or Sentry. There is no leak today — refusals are
`failed`, and only `INTERNAL` outcomes are reported — but "report refusals to Sentry too" is a
natural-sounding future change that would create one.

| Surface | Gets | Why |
|---|---|---|
| Customer response | Generic `failed`, fixed message | No provider prose, no echoed content |
| Log line | `failure_kind: 'refused'` only | Metadata, never content |
| Span | Same attribute, no payload | Same rule, wider audience |
| `trace_verdicts.raw_response` | Full moderation payload | Already stores provider payloads, already access-controlled |
| Console | Renders refused vs unparseable from the stored row | Behind auth, where content may live |

The published contract stays as-is until M5/M6 supplies real cases — which it will, since the
showcase tenant candidate is a prompt-injection judge with an adversarial eval set, i.e. the
judge most likely to trip moderation and be told its rubric is broken.

**D8 — No model catalogue at M1.** The three possible consumers all evaporate: the picker is
M4 (M1 seeds by script), capability *enforcement* is `require_parameters` and needs no
catalogue, and cost now comes from `usage.cost`. The framing that makes this a cut rather than
a postponement: **the catalogue is a menu, not a record** — the record is the frozen pin — so
freshness is a UX property, never a correctness one. `MODEL_PRICES` shrinks to the `fake:`
entry rather than being deleted.
**Tracked:** `docs/BUILD_SPINE.md` M4 was amended in this session to name the capability-gated
model picker explicitly, since it previously existed only as an ADR-0021 consequence with no
milestone. When built: lives in `src/llm/` (the fence), in-process TTL cache rather than a
table or a job, and three stages — *filter* on the cheap model-level union, *confirm* with the
per-model endpoints call, *prove* with D3's validation call.

**D11 — Reasoning is set explicitly on every call, its effort is pinned, and it defaults to
`none`.** *(ADR-0022)* Provider-side reasoning is a *second*, hidden deliberation layer on top of
the `rationale` field we deliberately generate first. The argument against inheriting it is not
cost but coherence: **hidden reasoning defeats ADR-0019's field ordering.** If a model deliberates
privately and then emits rationale → reasons → verdict, the verdict was settled during the
invisible part, and `rationale` becomes exactly the post-hoc rationalisation the ordering exists
to prevent — deliberation we pay for, cannot store, cannot show an annotator and cannot correct.
`exclude: true` is the worst option: the model reasons, we are billed, and we see nothing.
Whether reasoning makes judges *better* is empirical and deliberately not asserted — M6 can test
it as two judge versions, which is the mechanism the product already provides. Consequences:
effort joins quantization in the pin (it changes cost, latency and output for a frozen `jdv_`);
`reasoning.mandatory` becomes an honest picker gate at M4, since unlike data policy it is
queryable; and `reasoning_tokens` is stored on `trace_verdicts` regardless, so cost-per-verdict
stays explicable.

**D9 — CD: private GHCR images, Railway Pro.** CI pushes SHA-tagged images to GHCR; Railway
services source from them, so ADR-0011's chain stays intact and the digest CI booted and k6'd
is the digest that runs. Images stay **private**, which requires Railway Pro — $20/month per
workspace (not per seat), including $20/month of usage credit, so the credit likely covers a
four-service stack. Rejected: public images (free, and reasonable given the repo is public and
boots with no baked secrets, but the stakeholder chose private); `railway up` (rebuilds on
Railway, so the artifact CI tested is not the artifact that runs).

Topology mirrors compose rather than inventing one:

| Railway service | Source | Notes |
|---|---|---|
| `postgres` | `postgres:18.6` + volume | ADR-0013: ours, not the managed add-on |
| `migrate` | Same API image, `bun run db:setup` | `restartPolicyType: NEVER`; holds all three connection strings |
| `api` | API image, `healthcheckPath: /readyz` | Holds **only** `DATABASE_URL` |
| `web` | Web image | Built a second time against the production URL |

- **Ordering falls out of an existing property.** Railway has no equivalent of compose's
  `depends_on: service_completed_successfully`, but `/readyz` checks migration currency and
  503s when behind — so the healthcheck holds the deploy until migrations land.
- **`preDeployCommand` on the api service is rejected**, even though it is the Railway idiom:
  it would hand the API container the migrator credential and destroy the property `server.ts`
  is explicit about. A separate one-shot keeps the privilege split identical to compose.
- **The console image is environment-specific** because `VITE_API_URL` is a build arg. M1
  builds it twice; runtime config for the SPA is the correct fix and is parked. Reverse-proxying
  to make origins match is ruled out by ADR-0020.
- **Config the deploy must set**: `DATABASE_URL`, `APP_VERSION`, `GIT_SHA`,
  `BETTER_AUTH_SECRET`, `API_BASE_URL`, `WEB_ORIGIN`, `OPENROUTER_API_KEY`. The middle three
  are non-negotiable — `config.ts` rejects their placeholders in production.
- **`OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately unset at M1.** The Grafana stack is
  compose-only and shipping it is M3's work; unset is a supported state, so the tracer still
  runs and `request_id` is still a real W3C trace id.

**D10 — The seed pins three real models via env vars.** `SEED_MODEL_A/B/C`, all defaulting to
`fake:deterministic`, so local and CI keep zero-secret boot, deterministic tests and a free k6
smoke; Railway sets all three and gets a genuine multi-provider demo. One code path, no
branching on whether a key is present.

| Judge | Model | Price /M |
|---|---|---|
| `is-bug` | `openrouter:anthropic/claude-sonnet-5` | $2.00 / $10.00 |
| `is-feature` | `openrouter:openai/gpt-5.6-sol` | $2.00 / $10.00 |
| `is-question` | `openrouter:google/gemini-3.7-flash` | $0.75 / $3.75 |
| `needs-human` | `openrouter:anthropic/claude-sonnet-5` | $2.00 / $10.00 |

Sonnet 5 and gpt-5.6-sol are **identically priced**, so cost differences in the trace explorer
and M3 dashboards come from token counts and behaviour rather than price asymmetry; Gemini
Flash adds a ~2.7× cheaper third point and a third lab, which is the more interesting spread
for M6 agreement work. `needs-human` is the `required: true` veto judge, so it takes the
strongest model. Rejected: `z-ai/glm-5.3` — Z.AI's *own* endpoint fails the capability gate, so
the pin routes onto a rotating cast of third-party hosts (making the training concern twelve
policies instead of one), and its fp4/fp8/bf16 spread is precisely the reproducibility problem
in D4. `:batch` variants are excluded throughout: cheaper, but asynchronous.
**Two fragilities accepted knowingly rather than discovered later**, both measured above:
`gpt-5.6-sol` has exactly one available endpoint under the pin, so it has no failover — kept
because a judge with a real failure mode is a better circuit-breaker demonstration than three
identical ones; and `google/gemini-3.7-flash` has `mandatory: true` reasoning, so D11's default
cannot apply to it — kept because one uncontrollable judge beside two controllable ones makes the
difference visible and gives M6 something real to measure.

## Still open
1. **How Railway is told to deploy a new image tag.** Config-as-code does not appear to carry
   an image source, so this is likely a CLI or API call per deploy. Verify against a real
   project before the plan commits. A live-URL `/healthz` smoke should be added regardless —
   it is the only check that proves what is actually running.
2. ~~Is `usage.cost` denominated 1:1 with USD?~~ **Closed 2026-08-29** — confirmed exactly, on
   three models, with a real key. See "Verified with a live key".
3. **Exact `model_pin` shape** — now carrying capabilities, `data_collection`, quantization
   (D4) and reasoning effort (D11). Whether quantization binds on every pin or only on
   open-weights routes is a design detail for the plan, not a new decision.
4. **Whether D9 (CD topology) warrants its own ADR.** It commits to a paid plan and defines
   the production service graph, and "how do you deploy" is a certain interview question. It is
   recorded in the decisions log only. Would be ADR-0024.

## Recommended approach (input to planning, not the plan)
Sequence the work so the provider path is proven before anything depends on it:
1. **Adapter + port**, behind prefix dispatch, passing the existing contract suite. Derive the
   provider JSON schema from `judgeOutputSchema` via `z.toJSONSchema` (strict,
   `additionalProperties: false`) so the wire schema cannot drift from the contract — then
   **assert key order on the raw response text**, not the parsed object, because strict-mode
   enforcement varies by upstream and a provider treating the schema as a hint can emit
   `verdict` first, which Zod accepts and which silently deletes the deliberation the design
   rests on. Out of order → `invalid_output`.
2. **Failure mapping**, including D6's fourth kind and D7's refusal handling.
3. **Cost**: extend `ProviderResult` with an optional `costUsd`; `costOf` prefers it and falls
   back to the table, keeping `priced` honest. Add `input_tokens`, `output_tokens`, `cost_usd`,
   `cost_priced` to `trace_verdicts`.
4. **Schema**: the `model_pin` migration and its CHECK, mirroring the existing model/type rule.
5. **Seed**: `SEED_MODEL_A/B/C`.
6. **CD**, last, once there is something worth deploying.
Re-derive the 10s per-attempt timeout against a real frontier call on a large artifact before
M2's k6 work inherits it.
