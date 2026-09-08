# BREAKING_POINT.md — v0

**Measured 2026-09-08 · M2 · [ramp](../infra/k6/ramp.js) and [spike](../infra/k6/spike.js)**

> **The headline is a negative result, and it is the honest one: this run did not find the
> API's breaking point.** The rate limiter is the binding constraint long before capacity
> is, so what follows is a bound on the limiter and a proof that the request path holds
> under everything we could throw at it — not a saturation number. §6 says what that leaves
> unmeasured, and that section is what makes the rest of the document worth anything.

---

## 1. The topology tested

One of everything, on one machine, over the compose network.

| | |
|---|---|
| Host | Apple M1 Pro, 10 cores, 16 GB · macOS 26.2 · Docker 29.7.2 (7.65 GiB to the VM) |
| Stack | `infra/docker-compose.yml`, unmodified, all nine services |
| API | 1 instance, `NODE_ENV=development`, Bun 1.4 |
| Postgres | 1, `postgres:18.6` · Redis 1, `redis:8.2-alpine` |
| Telemetry | OTel Collector → Tempo, plus Prometheus and Grafana, all running and receiving |
| Judge | **The fake provider**, at `FAKE_PROVIDER_LATENCY_MS=4000`, spread 1500 |
| Load | k6 1.4.0 in a container on the same host, one seeded API key |

**The judge is a fake, and that is the single most important caveat in this document.** It
sleeps for a hash-derived interval and returns a canned verdict. The 4000 ± 1500 ms figure
is measured — `llm/retry.ts` recorded 1877–5304 ms across three real models on 2026-08-30 —
but a real judge call is *network I/O to another company's GPU*, and a sleep is not. The
shapes agree; the resource costs do not.

**One API key**, because no key-creation endpoint exists until the management API. This is
not a detail. It is the reason for the headline.

---

## 2. What was run

Both scripts drive `POST /v1/panels/{panel_id}/evaluate` — the product's one endpoint.

| | Ramp | Spike |
|---|---|---|
| Shape | 4 stages to 60 VUs, then down | 5 VUs → **150 VUs in 10s** → hold 1m → back to 5 |
| Duration | 4m30s | 2m50s |
| Requests | **1,276,195** | **533,659** |
| Mean rate | 4,641/s | 3,011/s |

The two mean rates are **not comparable** — the spike spends 1m30s of its 2m50s at 5 VUs by
design — and no per-stage series was captured, so this document does not claim a peak
throughput figure. What it claims is below.

---

## 3. The numbers

### Nothing failed

| | Ramp | Spike |
|---|---|---|
| `http_req_failed` | **0.00%** (0 of 1,276,195) | **0.00%** (0 of 533,659) |
| k6 checks | 100.00% (5,104,776) | 100.00% (1,600,767) |
| API `level=error` log lines | **0** | **0** |
| Circuit-breaker trips | **0** | **0** |
| Rate-limiter fail-open events | **0** | **0** |
| 5xx of any kind | **0** | **0** |

Across **1.81 million requests**, every single one was either served or cleanly refused.
Nothing was dropped, nothing timed out, nothing 500'd.

### Two populations, never one number

A run produces requests that have nothing in common with each other: a served evaluation
waits seconds on a judge, a refusal is rejected in milliseconds without touching Postgres,
the gateway or the provider. **Quoting one p95 over both is meaningless**, and the mistake is
easy to make — during development, `http_req_duration` p95 read **12 ms** on a run whose
served calls were taking **5.31 s**, because 99.9% of the sample was refusals. The scripts
record the two separately for that reason.

| Served (HTTP 200) | Ramp | Spike |
|---|---|---|
| min | 2.51 s | 2.52 s |
| median | 3.89 s | 3.94 s |
| p90 | 5.15 s | 5.21 s |
| **p95** | **5.35 s** | **5.29 s** |
| max | 5.49 s | 5.57 s |

The fake's own distribution is 4000 ± 1500 ms, i.e. **2.50 s to 5.50 s**. The served numbers
sit inside that envelope at both load levels, at both ends. **The API adds essentially nothing
to a judge call, and adds nothing more under load** — 60 VUs and 150 VUs produce the same
distribution, and the p95 does not move.

| Refused (HTTP 429) | Ramp (60 VUs) | Spike (150 VUs) |
|---|---|---|
| median | 5.05 ms | 23.07 ms |
| p90 | 8.36 ms | 29.83 ms |
| **p95** | **9.54 ms** | **31.87 ms** |
| max | 47.74 ms | 91.22 ms |

**This is the one number that moved, and it is the closest thing to a knee in this data.**
A refusal costs 9.5 ms at p95 under the ramp and **31.9 ms at the cliff — 3.3× worse**. It is
still ~170× cheaper than a served call, and it never approached the 1 s threshold, so the
limiter remained a cheap defence rather than becoming a cost of its own. But it is the one
part of the system that visibly degrades with concurrency.

### The limiter admitted almost exactly its own arithmetic

The policy is a token bucket: capacity 60, refilling at 1/second.

| | Duration | Theoretical admissions | Actually served | |
|---|---|---|---|---|
| Ramp | 270 s | 60 burst + 270 refill = **330** | **323** | 97.9% |
| Spike | 170 s | 60 burst + 170 refill = **230** | **207** | 90.0% |

Under sustained overload — over a million refusals — the bucket let through within a few
percent of what the arithmetic says it should. Independently confirmed in Postgres: **532
`traces` rows** were written during the two runs, which is 323 + 207 + the two `setup()`
probes, exactly.

### Memory

Peak across the whole stack: **1.60 GiB (ramp) / 1.35 GiB (spike)** of 7.65 GiB available.
Per container, at peak:

| | Ramp | Spike |
|---|---|---|
| **Tempo** | **542 MiB** | **569 MiB** |
| k6 (the load generator) | 359 MiB | 172 MiB |
| **API** | **322 MiB** | 351 MiB |
| Grafana | 188 MiB | 175 MiB |
| OTel Collector | 89 MiB | 88 MiB |
| Postgres | 67 MiB | 67 MiB |
| Prometheus | 56 MiB | 54 MiB |
| **Redis** | **12 MiB** | **12 MiB** |

**The trace store uses more memory than the service it observes**, at both load levels. That
is not a criticism of Tempo — it is receiving 2–3 spans per served request and holding
recent blocks in memory — but anyone sizing a host from the API's footprint alone would be
wrong by a factor of about three.

---

## 4. Where it broke first

**Under load: nothing broke.** Not the API, not Postgres, not Redis, not the breaker.

The only thing that broke during this milestone broke **outside** the request path, and it is
worth recording because it is the real operational lesson:

> A first attempt at the full 60-VU ramp on 2026-09-05 was **killed (exit 137)** — the k6
> container OOM'd against Docker's 7.65 GiB. The stack had been up for two days with Tempo
> accumulating spans across repeated load runs. Restarting the stack and re-running the
> identical script on 2026-09-08 completed with a peak of 1.60 GiB, well under the ceiling.

So the first thing to fall over was **accumulated observability state on a long-lived
development stack**, not the service. On this evidence, a host sized for the API and not for
its telemetry will run out of memory in the trace store first, and it will do it after days
rather than under peak load — which is the harder failure to attribute.

---

## 5. How it degrades

In the order the system actually reaches them:

1. **The limiter refuses.** Almost immediately, and for almost everything: **99.97%** of
   offered load in the ramp, **99.96%** in the spike. Every refusal is a well-formed
   `RATE_LIMITED` envelope carrying a `Retry-After` computed from the bucket. This is the
   whole degradation story, and it is graceful by construction: excess traffic is rejected
   in single-digit milliseconds without reaching Postgres, the gateway or a provider.
2. **Refusals get more expensive.** 9.5 ms → 31.9 ms at p95 between 60 and 150 VUs. Bounded,
   recoverable, never close to failing.
3. **Served calls do not notice.** The p95 of a served evaluation is unchanged between the
   two load levels and sits inside the dependency's own distribution.
4. **Nothing else was reached.** The breaker never opened, because the fake never failed. The
   fail-open path never ran, because Redis never faltered. Both are exercised in tests
   (`middleware/rate-limit.test.ts`, `llm/breaker.test.ts`); neither was exercised here, and
   this document cannot speak to how they behave under real load.

---

## 6. What was NOT measured

**Read this section as carefully as §3.** Everything above is a statement about one
configuration, and the gaps are large.

- **Anything with a real provider.** No real judge was called: no real network, no rate
  limits from a vendor, no cost, no token accounting against a real bill, none of the tail
  latency that `retry.ts` warns about (it caught `claude-haiku-4.5` at **15,092 ms** on the
  same probe that averaged 4 s — half again our 10 s timeout, on the model advertised as the
  fast one). Load-testing real providers was ruled out on 2026-09-04: a ramp is a million
  calls. **The timeout and retry budget therefore remain untested under load.**
- **More than one API key.** The single largest gap, and the direct cause of the headline. One
  key at 60/minute cannot generate more than ~1 served request per second, so **no amount of
  load through this key can saturate the instance**. The knee is unmeasured because it is
  unreachable with the key material that exists. When the management API ships and a load
  script can mint N keys, this document's central number should be replaced.
- **More than one API instance.** Nothing here tested horizontal scale — which is the entire
  case for Redis. See §7.
- **Anything sustained.** The longest run was **4m30s**. Leaks, unbounded growth, connection
  churn and compaction behaviour all live on timescales this does not touch. Soak is M3, with
  the observability to see a leak while it happens.
- **Postgres under real write load.** 532 rows were written across both runs, because the
  limiter refused everything else. The write path is essentially unexercised.
- **Realistic artifacts.** The load scripts send a short synthetic string. ADR-0023's cost
  model assumes ~2,700 input tokens. Request size, JSON parsing and the trace payloads stored
  are all far smaller here than in production.
- **Failure under load.** No provider failures, no Redis outage, no breaker trip, no
  fail-open — during a load run. Each is covered by a test; none was combined with concurrency.
- **A network.** Every component was on one host. No latency, no packet loss, no partition.
- **Cold start, restart and recovery**, and everything about deployment (M8).

---

## 7. Did a single instance ever need Redis?

**No. On this evidence, it did not — and that needs saying plainly** (ADR-0038 committed to
saying it).

The entire rate-limiting state for 1.81 million requests was **one Redis key**, occupying
**1.20 MiB** (peak 1.26 MiB) in a container that never exceeded **12 MiB**. Once the load
stopped, the key expired on its TTL and the keyspace returned to **zero**. A `Map` in the API
process would have held all of it — and one does: `rate-limit/memory-store.ts` passes the
same contract suite as the Redis adapter.

This does not make the decision wrong, and the reasoning should not be reconstructed after
the fact. **Redis was adopted on design grounds, ahead of the evidence D4 asked for**, and
ADR-0038 records exactly that, including why: the document that would have justified it is
this one, produced by the milestone that needed the store — a gate that could never open on
its own terms. What Redis buys is the case this run **did not test**: a second API instance,
where an in-process bucket gives each replica a full allowance and the limit silently becomes
N × 60/minute.

So the honest summary is: **the cost was one container and 12 MiB, the benefit is unmeasured
because it lies in a topology we have not built, and the decision was taken knowing that.**
The port (ADR-0039) is what keeps it cheap to reverse — the reversal is one adapter file, and
its replacement already exists and is already tested.

---

## 8. What would make v1 worth reading

In the order that would most change the numbers:

1. **Mint many keys**, so offered load can actually reach the evaluation path and this
   document can report a saturation point instead of a limiter bound.
2. **A second API instance**, which is the only way to test the claim Redis was adopted for.
3. **Soak** (M3), for the leak behaviour four minutes cannot show.
4. **One real-provider run at low volume**, to calibrate how far the fake's sleep is from a
   real call — not a ramp, just enough to know the size of the error.
5. **Failure injected under load**: kill Redis mid-ramp, fail the provider mid-ramp, and
   confirm the fail-open and breaker paths behave the way their unit tests say they do.

---

*Numbers in this document are reproducible with the commands in `infra/k6/ramp.js` and
`infra/k6/spike.js`. Both refuse to run against a zero-latency fake, so a run that starts is
a run that measures something.*
