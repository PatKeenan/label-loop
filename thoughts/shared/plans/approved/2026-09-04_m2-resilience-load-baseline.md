---
date: 2026-09-04T16:00:00Z
author: claude-code
status: approved
approved_at: 2026-09-04T17:00:00Z
approved_by: pat
milestone: M2
topic: m2-resilience-load-baseline
related_adrs: [0038, 0039, 0040, 0012, 0003, 0006, 0009, 0024]
research: thoughts/shared/research/2026-09-04_m2-resilience-load-baseline.md
---

# M2 — per-key rate limiting, a load baseline, and the breaking point

## Goal

Close the half of M2 that M0 did not already ship. Timeout, retry+jitter and the breaker are
live; the 429/503 envelope contract is complete down to an exhaustive console error map. What
is missing is the thing that *throws* `RATE_LIMITED`, the k6 ramp and spike scripts, and
`docs/BREAKING_POINT.md`. After this plan, a per-key token bucket in Redis rejects excess
traffic with a computed `Retry-After`, the fake provider can impersonate a realistic judge
latency so load runs are free and repeatable, and the repo publishes a real breaking point
with real numbers — including if the numbers are unimpressive.

**Milestone: M2** (`docs/BUILD_SPINE.md`, Category 5). It completes three of the four
Category-5 rows in `docs/SENIORITY_CHECKLIST.md:37-43`; the fourth (quota) is M8 by decision.

## Why three phases, and why this order

The phases exist because **the evidence runs backwards**. D4 says Redis waits until the
breaking-point document proves the need, but that document is produced by the milestone that
needs the store. The stakeholder cut that knot on 2026-09-04 by choosing Redis on design
grounds — so phase 1 builds the limiter, phase 2 measures the system with it in place, and
phase 3 publishes what the measurement actually showed. **If phase 3's numbers say a single
instance never needed Redis, that is a finding to publish, not to bury** (CLAUDE.md:
honest results over impressive results).

One branch + PR per phase, per CLAUDE.md.

## Phase 1 — the limiter

Branch: `feat/m2-p1-rate-limit`. PR title: `feat(api): per-key rate limiting, in Redis`.

### Redis, and what it costs

- [x] `infra/docker-compose.yml` — a `redis` service beside `postgres`, healthchecked
      (`redis-cli ping`) and depended on by `api` with `condition: service_healthy`, matching
      how `postgres` is wired. **No volume**: the counters are ephemeral by design and a
      restart losing them is correct behaviour, not data loss.
- [x] `apps/api/src/config.ts` — `REDIS_URL`, defaulting to the compose value the way
      `DATABASE_URL`'s row documents its own default. It is not a secret, so ADR-0009's
      zero-secret boot is unaffected.
- [x] `.env.example` — the matching row, under a `# ---------- M2: rate limiting ----------`
      heading, exhaustive per CONVENTIONS' "Config" rule.
- [x] `docs/STACK_DECISIONS.md` — **amend D4.** It currently reads *"No Redis until the k6
      breaking-point doc proves the need."* It becomes a decided row naming Redis, the date,
      that the decision was taken on design grounds ahead of its own evidence gate, and why
      (the sequencing trap). pg-boss stays on Postgres — this does not touch the queue.

### The store, behind a port

- [x] `apps/api/src/ports/rate-limit-store.ts` — port #3, in the register `clock.ts` and
      `error-reporter.ts` already use. One method: consume N tokens for a subject, answer
      allowed/remaining/reset. Everything Redis-shaped stays behind it.
- [x] `apps/api/src/rate-limit/redis-store.ts` — the real adapter, on **Bun's built-in
      `Bun.RedisClient`** (Bun 1.4.0). The bucket is one Lua script via `eval`, because
      read-then-write across two commands is a race that shows up exactly under the load this
      milestone exists to generate — and atomicity is the one thing a hand-rolled limiter
      cannot fake.
- [x] `apps/api/src/rate-limit/memory-store.ts` — the deterministic fake, a `Map` on the
      injected `Clock`. Peer of the real adapter, not a stub of it: both pass the same
      contract suite, the way `fake-provider` and `openrouter-provider` do.
- [x] `apps/api/src/rate-limit/store.contract-test.ts` — the shared suite both must pass,
      modelled on `apps/api/src/llm/provider.contract-test.ts`.

### The bucket and the middleware

- [x] `apps/api/src/rate-limit/token-bucket.ts` — hand-rolled (ADR-0012), `Clock`-injected,
      commented in the register of `retry.ts` and `breaker.ts`. Token bucket over fixed
      window so a caller keeps burst headroom; its state is two numbers per subject, which is
      what keeps the store swappable. **`DEFAULT_RATE_LIMIT`: capacity 60, refill 60/minute**,
      exported as a named policy beside `DEFAULT_BREAKER_POLICY` and `retry.ts`'s policy, so
      the three tunables of the resilience layer read the same way and live at the same
      altitude.
- [x] `apps/api/src/middleware/rate-limit.ts` — reads the subject from a **parameter, never a
      hardcoded key id**, so per-org at M8 is a call site rather than a refactor. Throws
      `AppError('RATE_LIMITED', …, { retryAfterSeconds })` computed from the bucket's reset,
      never a constant: `RATE_LIMITED` carries `retryAfter: true` in `ERROR_SPEC` and the
      central handler already reads it.
- [x] `apps/api/src/routes/public/v1/evaluate.ts:41` — chained **after** `apiKeyAuth()` in the
      same `middleware` array. Order is load-bearing and gets its own test: limiting before
      authentication would let an anonymous flood burn a real key's allowance.
- [x] `apps/api/src/app-env.ts` — `rateLimitStore` on `AppDeps`, injected like `modelGateway`
      and for the same stated reason: it is stateful, and one rebuilt per request would never
      limit anything.
- [x] `apps/api/src/server.ts` — compose the real adapter once, beside the gateway.
- [x] **Fail open.** A store error — unreachable Redis, a timeout — is caught in the
      middleware, logged at `warn` with the subject, reported to the `ErrorReporter` port, and
      the request proceeds. It must never surface as a 500: a broken limiter is our problem,
      not the caller's.
- [x] **No new error codes.** `RATE_LIMITED` and `QUOTA_EXCEEDED` already exist with the right
      statuses and retry semantics. If this phase reaches for a code, the design has drifted.

### Tests

- [x] `token-bucket.test.ts` — refill, burst, exhaustion, and reset arithmetic, all on a fake
      clock and none of them sleeping.
- [x] `middleware/rate-limit.test.ts` — the 429 envelope, `Retry-After` present and matching
      the bucket, and **the ordering assertion**: an unauthenticated request is 401 and
      consumes nothing.
- [x] `store.contract-test.ts` run against both adapters, the Redis one gated on a reachable
      `REDIS_URL` the way database tests are.
- [x] **A fail-open test**: a store that throws lets the request through, logs a warning and
      reports — asserted directly, because this path only ever runs when something is already
      wrong and would otherwise be discovered during the outage it exists for.
- [x] `apps/api/src/routes/public/v1/evaluate.test.ts` — one case proving a limited caller
      gets 429 rather than a judge call.

### Automated verification

- [x] `bun run lint`, `bun run typecheck`, `bun test` all green.
- [x] `docker compose -f infra/docker-compose.yml up -d --wait` — `redis` healthy, `api`
      waiting on it.
- [x] The seeded key 429s when driven past the constant, and the response carries
      `Retry-After`.

### Manual verification

- [ ] Drive the seeded key past the limit by hand; confirm the envelope reads the way the
      console's error map expects (`apps/web/src/errors/error-map.ts:84`).
- [ ] `docker compose stop redis`, then send a request. **Confirm the fail-open behaviour
      decided below is what actually happens**, and that the log says so.

## Phase 2 — a fake that can be loaded, and the scripts that load it

Branch: `feat/m2-p2-load-scripts`. PR title: `feat(k6): ramp and spike, against a fake with
real latency`.

**This lands after phase 1 and before phase 3**, because a ramp with no limiter measures a
system that no longer exists, and a ramp against a zero-latency fake measures a hash.

- [x] `apps/api/src/llm/fake-provider.ts` — a latency option on `FakeProviderOptions`, beside
      `failFirst`/`failWith`. It impersonates a ~4s judge (the measured figure in
      `retry.ts`'s header table, not a guess) with configurable spread. **Deterministic per
      call** — derived from the same hash the verdict is, so a load run is repeatable rather
      than merely random. Distinct from the `__slow__` sentinel, which never returns.
- [x] `apps/api/src/llm/fake-provider.test.ts` — latency is applied, is deterministic for the
      same call, and is zero by default so no existing test slows down.
- [x] `infra/k6/ramp.js` — staged ramp to find the knee. Thresholds on p95 and on
      `http_req_failed`, with `expectedStatuses` told about the 429s so a limiter working
      correctly does not read as failure — the same honesty `smoke.js:33-38` already applies.
- [x] `infra/k6/spike.js` — a step change, to show the breaker and the limiter behaving under
      a cliff rather than a slope.
- [x] `infra/docker-compose.yml` — both under the existing `k6` profile, with the fake's
      latency set through the `api` service's environment so a load run needs no code edit.
- [x] **CI runs smoke only.** Ramp and spike are operator-run; adding minutes of load to every
      PR buys nothing and makes the pipeline flaky on shared runners.

### Automated verification

- [x] `bun test` green — the latency default must not have slowed the suite.
- [x] `docker compose --profile k6 run --rm k6 run /scripts/ramp.js` completes and its
      thresholds are meaningful (they fail when pointed at a deliberately low limit).
- [x] The existing smoke script still passes unchanged in CI.

### Manual verification

- [x] Watch a ramp in Grafana: latency climbing, then 429s appearing, then the breaker
      tripping if pushed past it. The nesting should make the sequence readable.
      **Half of this was not possible — see Deviation 13.** The nesting IS readable, in
      Explore → Tempo. The climbing-latency graph does not exist and cannot at M2: there are
      no dashboards and no application metrics until M3.

## Phase 3 — `docs/BREAKING_POINT.md` v0

Branch: `docs/m2-p3-breaking-point`. PR title: `docs: the breaking point, with real numbers`.

- [x] Run ramp and spike against the composed stack and record what actually happened.
- [x] `docs/BREAKING_POINT.md` — v0: the topology tested, the numbers, where it broke first,
      how it degraded, and **what was not measured** (real provider latency and cost, multi
      instance, sustained soak). The last section is the one that makes the rest trustworthy.
- [x] State plainly whether a single instance ever needed Redis. If it did not, say so and
      note that the store was chosen on design grounds — D4's amendment already says this, and
      the document should agree with it rather than quietly imply evidence it does not have.
- [x] `docs/SENIORITY_CHECKLIST.md` — check rows 38, 41 and 43. Row 42 (quota) stays open,
      annotated M8.

### Automated verification

- [x] Nothing changes in code; `lint`, `typecheck`, `test` must be untouched, exactly as P3's
      prose sweep argued.

### Manual verification

- [ ] Read it as a sceptical reader: could someone reproduce these numbers from what is
      written? If not, the method section is short a step.

## Decisions made

- **Redis is the counter store, chosen ahead of the evidence D4 asks for.** The sequencing
  trap is real — the document that would justify it is produced by the milestone that needs
  it — so it is cut rather than solved, and D4 is amended to say exactly that rather than
  being left to contradict the build. Stakeholder, 2026-09-04.
- **Bun's built-in `Bun.RedisClient`, so Redis adds no npm dependency.** Bun 1.4.0 ships a
  Redis client with `eval`/`evalsha`, which is everything an atomic token bucket needs. Judged
  by what it would replace (`ioredis` or `node-redis`): the built-in replaces it entirely, so
  the package would buy nothing. This is a runtime capability, not a resilience library — it
  does not touch ADR-0012, which is about not importing the *behaviour*.
- **The bucket is hand-rolled; only the storage is delegated.** ADR-0012 makes this a standing
  principle and `retry.ts` states the reasoning: these primitives are the Category-5 artefact,
  so importing one hands away the thing being demonstrated. The Lua script is the exception
  that proves it — atomicity is a property of the store, not behaviour we could hand-roll
  correctly anyway.
- **The counter store is a port with a real adapter and a deterministic fake**, matching
  `ModelProvider`. It is what makes the D4 decision reversible if phase 3's numbers embarrass
  it, and it is why the store choice does not have to be right first time.
- **Per-key only, with a fixed constant, and the subject parameterised.** Per-org
  `QUOTA_EXCEEDED` and the usage meter go to M8. The split is already encoded in the M0 error
  taxonomy — `RATE_LIMITED` retryable, `QUOTA_EXCEEDED` not — and no key-creation endpoint
  exists today, so the mint-more-keys bypass is theoretical until the management API ships.
  Stakeholder, 2026-09-04.
- **The limiter fails OPEN when Redis is unreachable**, logging a warning and reporting to
  Sentry — stakeholder, 2026-09-04. A limiter outage becoming a service outage is a worse
  failure than a brief window of unlimited traffic, and M2's whole subject is graceful
  degradation. **The cost, recorded rather than waved away:** during a Redis outage there is
  no bound on traffic at all, which is acceptable precisely because the limit is about
  throughput fairness and not about cost. **It stops being acceptable the day the limiter is
  load-bearing for spend** — which is what per-org `QUOTA_EXCEEDED` at M8 will be, so that
  milestone should revisit this rather than inherit it. A fail-open limiter is also invisible
  when it breaks, so the warning log and the Sentry report are the decision's other half, not
  decoration.
- **The limit is 60 requests per minute per key, burst 60** — stakeholder, 2026-09-04. Read
  as a token bucket: capacity 60, refilling at 1/second, so a caller may spend a full minute's
  allowance at once and then sustains 1/second. Deliberately loose for a first number, and
  phase 3 is where evidence either tightens it or leaves it alone.
- **Rate limiting runs after authentication, and the order is tested.** Limiting first would
  let an anonymous flood consume a real key's allowance.
- **The fake gets deterministic latency, and it lands before the k6 scripts.** Otherwise the
  scripts' first numbers describe a system that is about to change. Stakeholder, 2026-09-04.
- **CI runs smoke only; ramp and spike are operator-run.** Minutes of load per PR buys nothing
  and is flaky on shared runners.
- **`BREAKING_POINT.md` publishes the real number and names what it did not measure.**

## Explicitly NOT doing

- **Per-org quota, the usage meter, and any billing concept.** M8.
- **A per-key rate-limit column.** No surface can write one until the management API ships;
  it lands with that API. CONVENTIONS:46 under-delivers until then, knowingly.
- **Scoped keys** (`evaluate`/`read`/`manage`), which PRODUCT 5.1 flags as needing an ADR
  amendment. Adjacent, not this milestone.
- **Soak.** The checklist lists it beside ramp and spike, but it measures leak behaviour over
  hours and belongs with M3's observability, where a leak would actually be visible.
- **Autoscaling, multi-region, queue-based buffering** — BUILD_SPINE's own "not now" for M2.
- **Load-testing real providers.** Settled 2026-09-04: a ramp is thousands of calls.
- **Touching `retry.ts`'s measured `timeoutMs` or the breaker's thresholds.** If phase 3 says
  they are wrong, that is a finding for its own change with its own evidence.

## Deviations

Recorded as they happened, because they are decision provenance too (CLAUDE.md).

### Phase 1

1. **The port is #4, not #3.** The plan calls `rate-limit-store.ts` "port #3". The register
   already reads `ModelProvider` #1, `Clock` #2, `ErrorReporter` #3, so the counter store is
   the fourth and is numbered that way in the file. A documentation slip, not a design change.

2. **The Redis adapter needed a command deadline, and the plan's fail-open does not work
   without one.** The plan says a store error "is caught in the middleware". Measured against
   a real client: an unreachable Redis does not throw. Bun's `RedisClient` queues the command
   and waits for a reconnection that may never come, so the `catch` never runs and the request
   **hangs** — strictly worse than having no limiter. `createRedisRateLimitStore` therefore
   races every `EVAL` against a 250ms deadline (invisible against a judge call measured in
   seconds), which is what converts "unreachable" into the catchable rejection the plan
   assumed. It covers a hung-but-connected Redis for free.

3. **Bun's client stops reconnecting permanently, so the store rebuilds it.** Found by the
   manual verification, not by a test: after `docker compose stop redis` / `start redis`, the
   API kept failing open **indefinitely** — every request logging "Connection has failed" —
   until the process was restarted. Bun's `RedisClient` retries a few times and then enters a
   terminal state; raising `maxRetries` to two billion fixed it in a host-process probe and
   did **not** fix it against the composed stack, where a restarted container also returns on
   a fresh address. The adapter now discards a client that reports itself disconnected and
   builds a new one (at most once a second), which re-resolves the hostname. Without this,
   ADR-0040's fail-open is not a brief degradation but a permanent one: a ten-second Redis
   restart would leave the limiter off until someone redeployed. Verified end to end —
   healthy 60/20, outage 80/0, recovery limiting again with no API restart.
   `redis-store.test.ts` carries a regression guard.

4. **CI gained a `redis` service.** The plan asks for the Redis contract test to be "gated on
   a reachable `REDIS_URL` the way database tests are" — and the database way, stated in
   `ci.yml` itself, is that CI runs a real one and the test does not skip. A skipped store
   test would read green while proving nothing about the Lua under concurrency, which is the
   only thing that adapter exists for.

5. **Compose publishes Redis on 6380, not 6379**, and `config.ts` defaults to match. The same
   reasoning the file already gives for Postgres on 5433: a developer machine often has a
   Redis on the default port, and that collision is silent — the buckets would simply be
   shared with whatever else is running. CI uses 6379, as it does 5432, because a runner has
   nothing else on the port.

6. **`token-bucket.ts` splits into a pure function and a clock-bound wrapper.** The plan says
   the bucket is "`Clock`-injected"; it is, through `createTokenBucket`, but the arithmetic
   itself is `consume(state, {nowMs, cost, policy})` — a pure function with no clock and no
   I/O. That split is what lets the Lua in `redis-store.ts` be a transcription of a written
   specification rather than of a closure, and what lets the whole schedule be asserted in
   microseconds. The duplication it creates is deliberate and is exactly what
   `store.contract-test.ts` exists to police.

### Phase 2

7. **The ramp's first numbers were meaningless, and the fix is the interesting part.** A run
   produces two populations that have nothing to do with each other: a served evaluation
   waits on a judge for seconds, a refused one is rejected in milliseconds without touching
   anything. With one seeded key at 60/minute, **99.94% of a ramp is refusals** — so
   `http_req_duration` p95 read as **12ms** while served calls were actually taking **5.3s**.
   A threshold on the mixture is a threshold on the cheap population, and it would have
   passed through any amount of degradation. Both scripts now record `served_duration`,
   `refused_duration` and `limited_rate` separately and threshold on the served population.
   The plan asked for "thresholds on p95 and on `http_req_failed`"; taken literally that
   produces a number that describes nothing.

8. **The question the ramp actually answers had to change with it.** One key cannot generate
   more than one served request per second, so the limiter is the binding constraint long
   before this instance's capacity is — a ramp cannot find the knee with the key material
   that exists, and no key-creation endpoint ships until the management API. What it CAN
   answer, and now does: **does a flood of refusals degrade the calls that are served?**
   Measured on 2026-09-04 at 40 VUs — 2433 req/s, served p95 5.31s against a fake configured
   at 4000ms ± 1500, refused p95 12ms. It does not. That is a real finding and a threshold
   that can fail, which was verified by pointing it at a 9000ms fake: `served_duration` p95
   9.46s, threshold crossed, run red.

9. **`compose run` silently recreates the API, and that made a load run measure nothing.**
   A service whose environment differs from the running container is considered out of date
   and restarted — so bringing the stack up with `FAKE_PROVIDER_LATENCY_MS=4000` and then
   running k6 without repeating it restarts the API at zero latency. Observed exactly that:
   `served_duration` p95 of **73ms** against a fake configured for 4000ms, every threshold
   green, the run about nothing. `ci.yml`'s k6 step documents the same trap for its build
   args, which is how it was recognised. Both scripts now have a `setup()` that probes one
   call and **refuses to start** if the judge answered too fast, printing the command that
   fixes it (`ALLOW_FAST_JUDGE=1` to override when measuring the limiter alone).

10. **A shared `infra/k6/load-lib.js`**, used by `ramp.js` and `spike.js` and deliberately
    NOT by `smoke.js` — the smoke test is CI's gate and stays self-contained, because a
    shared module is one more thing that can break the one script that has to work.

11. **`biome.json` turns off `noConsole` for `infra/k6/**`.** k6 has no logger; `console.log`
    is the only channel a script has to reach the operator. The ban exists to protect the
    API's structured logging (CONVENTIONS.md "Logging"), and there is nothing of that kind
    here to protect. The rationale is recorded in `load-lib.js`, because `biome.json` cannot
    carry a comment.

12. **The load knob is two env vars, not one.** `FAKE_PROVIDER_LATENCY_MS` and
    `FAKE_PROVIDER_LATENCY_SPREAD_MS`, both defaulting to 0. The plan said "a latency option
    ... with configurable spread"; making the spread separately settable is what lets an
    operator collapse the distribution to a constant when isolating a variable.

13. **"Watch a ramp in Grafana" was half-impossible as written, and the plan should have
    known.** Verified with the stakeholder on 2026-09-05. What works: the trace nesting, in
    Explore → Tempo, and it shows exactly what the step wanted — a served call as
    `POST …/evaluate` → `judge needs-human` → `provider call fake:deterministic` with the 4s
    latency, `attempts`, cost and `judge_version_id` on the spans; a refused call as a bare
    root span with **no children at all**, which is the visual proof the limiter refuses
    before any judge is called.

    What does not work, and is nobody's mistake: **there is no latency graph, because there
    are no dashboards and no application metrics.** `infra/prometheus/prometheus.yml` scrapes
    the collector, Tempo and itself and says application metrics and dashboards are M3;
    `infra/tempo/tempo.yaml` says the same of `metrics_generator`, which is why Grafana's
    Traces Drilldown Breakdown tab answers `error finding generators: empty ring`. Logs are
    not in Grafana either — no Loki until M3, by the collector config's own note.

    Three consequences, and the first is the one that matters:
    - **M2's evidence is k6's own summary plus trace inspection**, not a Grafana screenshot.
      `docs/BREAKING_POINT.md` is written from the former and must not imply the latter.
    - The step should have been caught when the plan was written; a manual-verification step
      that assumes a surface a later milestone owns is a plan reviewing itself optimistically.
    - Enabling Tempo's `metrics_generator` (plus `--web.enable-remote-write-receiver` on
      Prometheus) is a small two-file change that would light up Drilldown and give real RED
      series. **Deliberately NOT done here** — stakeholder decision, 2026-09-05: it is M3 by
      the register's own words, and pulling it into M2 to make one checkbox tickable is the
      wrong reason to move a milestone boundary.

### Phase 3

14. **Checklist row 38 stays OPEN, against the plan's instruction to check it.** The plan says
    to check rows 38, 41 and 43. Row 38 reads *"k6 scenarios: smoke, ramp, spike, soak"* — and
    this plan's own "Explicitly NOT doing" defers soak to M3. Three of four is not four, and
    `CLAUDE.md` says to check an item only when the artifact is live. Ticking it would be
    exactly the rounding-up the checklist exists to prevent, so the row is annotated with what
    shipped and what did not instead. Rows 41 and 43 are checked; row 42 stays open annotated
    M8 as planned.

15. **The headline is a negative result, and the document leads with it.** The plan expected
    numbers showing where the system breaks. What the runs show is that **the limiter binds
    long before capacity does**: 99.97% of offered load is refused, and one key cannot push
    more than ~1 served request per second, so no amount of load reaches the knee. Nothing
    broke — 0 failures across 1.81M requests, 0 errors, 0 breaker trips, 0 fail-open events —
    and served latency was flat between 60 and 150 VUs, sitting inside the fake judge's own
    distribution at both. `BREAKING_POINT.md` says so in its first paragraph rather than
    burying it behind numbers that look more impressive than they are.

16. **The one thing that actually broke was the observability stack, days before the load.**
    The first attempt at the full 60-VU ramp on 2026-09-05 was OOM-killed (exit 137) against
    Docker's 7.65 GiB, on a stack that had been up two days accumulating spans. The identical
    script on a freshly restarted stack peaked at 1.60 GiB. Tempo was the largest consumer in
    both runs — **542–569 MiB against the API's 322–351 MiB** — so a host sized from the
    API's footprint is wrong by roughly 3×. Recorded in §4 as the answer to "where did it
    break first", because it is the true one.

17. **The Redis verdict, stated as ADR-0038 required.** One key, 1.20 MiB, in a container that
    never exceeded 12 MiB — and zero keys once the TTL expired after the load stopped. A
    single instance never needed it, and §7 says that plainly rather than implying evidence it
    does not have. What Redis buys is the multi-instance case, which this run did not test and
    the document does not pretend to have tested.

### Noted, not fixed

- **`apps/api/src/jobs/queue.test.ts` failed locally** in BOTH phases, on the unmodified tree
  as well as the modified one — the composed `api` container runs its own pg-boss worker
  against the same database the host tests use. Stopping the container is not enough; only
  `docker compose down -v` plus `bun run db:setup` cleared it, which points at leftover
  pg-boss queue state rather than a live competitor alone. Nothing to do with either phase,
  and out of scope for this plan — but it has now cost time twice, so it is worth its own
  change: the test should own a uniquely-named queue per run rather than sharing one.

## Open questions

**None outstanding.** All three were settled by the stakeholder on 2026-09-04 and are recorded
in "Decisions made" above rather than left here:

1. ~~Fail-open or fail-closed?~~ **Fail open**, with the warning log and Sentry report as the
   other half of the decision, and a note that M8's spend-bearing quota should revisit it.
2. ~~What is the constant?~~ **60/minute per key, burst 60.** Deliberately loose for a first
   number; phase 3 tightens it or leaves it alone on evidence.
3. ~~Does the limiter cover `/internal/*`?~~ **`/v1` only** — planned that way and not
   objected to. The console is session-authenticated, has no key to key off, and is not the
   surface under load.
