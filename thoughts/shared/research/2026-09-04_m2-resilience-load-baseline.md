---
date: 2026-09-04T15:10:00Z
author: claude-code
status: draft
milestone: M2
topic: m2-resilience-load-baseline
related_adrs: [0012, 0003, 0006, 0021, 0024]
---

# M2 — resilience and load baseline: what exists, what is missing, what has to be decided

## Problem summary

M2 is *"per-key rate limiting, request timeouts, retries with exponential backoff + jitter,
circuit breaker, graceful 429/503 envelopes; k6 smoke + ramp + spike; `docs/BREAKING_POINT.md`
v0 with real numbers"* (`docs/BUILD_SPINE.md`). **Roughly half of that shipped at M0.** Timeout,
retry+jitter and the breaker are live and tested, and the 429/503 envelope contract is complete
down to an exhaustive web error map. What is genuinely missing is **per-key rate limiting** —
which has no database column, no middleware and no state store — plus the ramp and spike
scripts and the breaking-point document.

The two hard problems are not the rate limiter's algorithm. They are **where its counter lives**
(a stack decision D4 explicitly defers to this milestone) and **what the load test runs against**,
given that the project's own checklist says load numbers against the fake provider *"would
measure a hash"*.

## Relevant files and why each matters

**Already built — read before adding anything:**

- `apps/api/src/llm/retry.ts` — per-attempt timeout + backoff/jitter in one file, deliberately.
  `timeoutMs` is *measured* against real models on 2026-08-30, not guessed; the table is in the
  file's header comment. Any M2 change to it has to re-derive rather than re-guess.
- `apps/api/src/llm/breaker.ts` — three-state breaker (`closed`/`open`/`half_open`), 5 consecutive
  failures, 30s open. Half-open admits exactly one probe. Injected `Clock`, so it tests without sleeps.
- `apps/api/src/llm/gateway.ts` + `attributes.ts` — the single seam every provider call passes
  through; where retry, breaker and span attributes compose.
- `packages/contracts/src/errors.ts` — the closed taxonomy. `RATE_LIMITED` (429, retryable,
  `Retry-After` required) and `QUOTA_EXCEEDED` (429, *not* retryable) **already exist and are
  already tested**, including the assertion that they share a status and mean opposite things.
- `apps/web/src/errors/error-map.ts:84-97` — the console already renders both codes. The contract
  half of "graceful 429" is done; only the thing that *throws* it is missing.
- `apps/api/src/routes/demo-errors.ts:22` — already throws `RATE_LIMITED` with `retryAfterSeconds`,
  so the envelope and header path are exercised end to end today.
- `infra/k6/smoke.js` — one VU, one pass, run in CI (`ci.yml:218`) from the `grafana/k6` container
  under a compose profile, never a host install. Its header already names ramp/spike/soak as M2.
  `JUDGES = ['needs-human']` — it tracks the seeded panel, so P2 will touch it.

**The seam M2 plugs into:**

- `apps/api/src/middleware/api-key-auth.ts:74` — sets `c.set('apiKey', { id, orgId, panelId })`.
  A limiter chained immediately after this has the key id with no extra lookup. This is the
  natural insertion point and it already exists.
- `apps/api/src/app.ts:76-100` — the middleware chain and the deliberate structural split between
  the public `/v1` surface and the internal console routes.
- `packages/db/src/schema/api-keys.ts` — **no limit, window, or usage columns.** `0010_*.sql`
  would be M2's migration.

**Documents that constrain it:**

- `docs/adr/0012-hand-rolled-resilience.md` — timeout, retry, breaker, *"and later backpressure and
  rate limiting"* are hand-rolled as a **standing principle**. It also says explicitly: rate limiting
  is M2 and *"must not leak forward"* into M0. Any resilience library is a STACK_DECISIONS row.
- `docs/STACK_DECISIONS.md` D4 — pg-boss on Postgres, *"**No Redis until the k6 breaking-point doc
  proves the need**"*. M2 produces that document, so M2 is where the question gets answered.
- `docs/CONVENTIONS.md:46` (ADR-0003) — *"every key is scoped to one panel and carries its own rate
  limit **+ usage meter**"*. The meter is a promise the schema does not yet keep.
- `docs/SENIORITY_CHECKLIST.md:37-43` — four Category-5 rows, all unchecked, all M2 except quota
  (M2/M8).

## Existing patterns and constraints that apply

1. **Hand-rolled, and it is the artefact** (ADR-0012). `retry.ts`'s header states the reasoning
   plainly: these primitives *are* the Category-5 thing being demonstrated, so importing them
   "would hand away the thing being shown". A rate limiter is the next one in that sequence.
   **This cuts against the general preference for judging a package by what it would replace** —
   here the code is the deliverable, not incidental plumbing. Worth stating in the plan rather
   than assuming either way.
2. **Injected `Clock` everywhere** (`apps/api/src/ports/clock.ts`). Both existing primitives take
   one and are deterministic without sleeps. A limiter that reads `Date.now()` directly breaks the
   pattern and its own tests.
3. **The error taxonomy is closed and total.** Adding a code is a contracts PR; `ERROR_SPEC` is a
   total `Record`, and `apps/web`'s map is exhaustive. M2 should need **no new codes** — both 429s
   already exist, which is a strong signal the taxonomy was designed for this milestone.
4. **`Retry-After` is contract, not courtesy.** `RATE_LIMITED` carries `retryAfter: true`, and the
   central handler reads it. A limiter that 429s without a computed reset time violates the spec
   its own test asserts.
5. **Ports & adapters.** A counter store is an external effect, so it is a port with a real adapter
   and a deterministic fake — the same shape as `ModelProvider`. That is what keeps the Postgres
   vs Redis question a swap rather than a rewrite, and it is the reason the decision does not have
   to be made perfectly on the first try.

## Open questions for the human — ALL SETTLED 2026-09-04

1. **Where does the rate-limit counter live?** This is the milestone's real architectural decision
   and it is a D4 stack question, so it is yours, not mine. In-process (a `Map` per instance) is
   free, needs no migration and is *wrong the moment a second API replica exists* — it silently
   becomes an N×limit limiter. Postgres keeps the "no Redis until proven" rule and reuses a
   dependency already there, at the cost of a write on every request on the hot path. Redis is the
   textbook answer and is exactly what D4 says the breaking-point doc must justify first.
   **There is a sequencing trap here:** the document that is supposed to justify Redis is produced
   by the milestone that needs the decision. Worth deciding deliberately rather than discovering.
2. **What do the ramp and spike scripts actually drive?** The checklist says load numbers against
   the fake provider *"would measure a hash"* — and it is right about the judge path, but a ramp
   against the fake still measures Hono, Postgres, the connection pool, auth's SHA-256 per request,
   and the limiter itself, which is most of what breaks first under load. Real models measure the
   true end-to-end shape and cost money per run — a ramp is thousands of calls, not the single
   validating call P3 spent. Options: fake-only and say so; fake for CI plus one documented paid
   run for `BREAKING_POINT.md`; or **give the fake a configurable latency distribution** so it can
   impersonate a ~4s judge without a bill (it currently has no such knob — only the `__slow__`
   sentinel that never returns).
3. **Is the limit per key, per org, or both — and is it configured or fixed?** ADR-0003 says
   per-key. A per-key-only limit means an org can multiply its throughput by minting keys, which
   is fine if keys are the billing unit and a hole if they are not. Related: does the limit go in a
   column (per-key configurable, which is what "carries its own rate limit" implies) or start as
   one global constant?
4. **Does the usage meter land here or at M8?** CONVENTIONS pairs it with the rate limit in one
   sentence, and a limiter already counts requests — so the meter is nearly free *if* the counter
   is durable, and a separate build if the counter is in memory. This partly answers itself once
   question 1 is settled. The checklist hedges it as "M2/M8".
5. **Does `BREAKING_POINT.md` v0 publish a number that is currently embarrassing?** The honest-results
   rule says yes. Worth confirming, since it is the first public artefact with a number attached to
   it that is not a passing test.

## How they were settled (stakeholder, 2026-09-04, in conversation)

Recorded here so a fresh session plans from the answers rather than reopening them.
Full rationale: `thoughts/shared/progress/decisions-log.md` (2026-09-04T15:40Z, 15:42Z).

1. **Redis.** Chosen on design grounds, ahead of the evidence D4 asks for — the sequencing
   trap is real and is being cut rather than solved. **D4 is amended and an ADR says so
   plainly**; `BREAKING_POINT.md` still reports what the numbers actually show, including if
   they show a single instance never needed it. New cost: a container in every local stack
   and in CI, and a second data store at M3 and M8.
2. **The fake gets a configurable latency distribution**, and ramp/spike run against it. Keeps
   every run free, repeatable and CI-available, and still exercises what breaks first (Hono,
   the pool, per-request SHA-256, the limiter). **It lands before the k6 scripts**, not after.
   `BREAKING_POINT.md` says plainly what was and was not measured.
3. **Per-key only, fixed constant.** No limit column at M2 — there is no surface to write one
   until the management API ships. **The limiter's subject is a parameter, not a hardcoded key
   id**, so per-org is a call site rather than a refactor.
4. **The usage meter travels with quota to M8**, following from 3.
5. **`BREAKING_POINT.md` publishes the real number**, per CLAUDE.md's honest-results rule.

**The accepted hole, stated so nobody rediscovers it as a bug:** a per-key-only limit is
fairness between a tenant's own clients, not a bound on one tenant. A tenant wanting more
throughput mints another key. Tolerable at M2 because no key-creation endpoint exists — the
seed is the only writer of `api_keys` — and it closes at M8 with per-org `QUOTA_EXCEEDED`.

## Recommended approach (input to planning, not the plan)

- **Split the milestone at the decision.** Phase 1 is the rate limiter behind a counter port, with
  the in-process adapter and its deterministic fake; phase 2 is k6 ramp/spike plus `BREAKING_POINT.md`;
  a phase 3 swaps the adapter *if* phase 2's numbers say so. This makes the D4 question answerable
  with evidence instead of ahead of it, which is what D4 asked for, and no phase blocks on a decision
  the previous phase has not yet informed.
- **Take the algorithm off the table early.** Token bucket, hand-rolled, `Clock`-injected, one file
  beside `retry.ts` and `breaker.ts` with the same commenting register. It is the standard answer,
  it gives burst tolerance for free, and its state is two numbers per key — which is what makes the
  store swappable.
- **Chain the limiter immediately after `apiKeyAuth`**, so it always has a resolved key id and an
  unauthenticated request is rejected before it can consume budget. Ordering is worth an explicit
  test: rate-limiting before auth would let an anonymous flood exhaust a real key's allowance.
- **Do not add error codes.** If the plan reaches for one, that is a signal the design has drifted.
- **Resolve question 2 before writing the k6 scripts**, not after. A fake-latency knob is a small
  change to `fake-provider.ts` that would make every subsequent load run free and repeatable; if it
  is wanted, it should land before the scripts rather than invalidating their first numbers.
