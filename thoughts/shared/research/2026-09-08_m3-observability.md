---
date: 2026-09-08T15:10:00Z
author: claude-code
status: draft
milestone: M3
topic: m3-observability
related_adrs: [0007, 0010, 0011, 0024, 0016, 0009, 0013]
---

# M3 — Observability: metrics, dashboards, one alert rule, and the log pipeline

## Problem summary

**The API emits no application metrics at all.** `otel.ts` builds a `BasicTracerProvider`
and nothing else — there is no `MeterProvider`, no metrics exporter in `apps/api/package.json`,
and no `/metrics` route. Prometheus scrapes only the telemetry stack itself (collector, Tempo,
itself), Grafana has two provisioned datasources and **zero dashboards**, and the collector has
a traces pipeline only. Traces are the one signal that genuinely works end to end.

M3 closes that: application metrics, dashboards as code (p50/p95/p99, error rate, cost/min,
per-key usage), one alert rule, and the filelog → Loki log pipeline ADR-0007 already assigned
here. The span attributes needed for almost all of it **already exist and are deliberate**
(`llm/attributes.ts`), so this milestone is mostly about a second signal and its presentation,
not about new instrumentation points.

## Relevant files and why each matters

| File | Why |
|---|---|
| `apps/api/src/otel.ts` | The whole SDK bootstrap. Trace-only today; the `MeterProvider` goes here, and its two failure bridges (`diag` + global error handler) are the pattern a metrics exporter must copy |
| `apps/api/src/llm/attributes.ts` | Every attribute the cost/token dashboards need already exists and is namespaced — `cost_usd`, `cost_priced`, `reasoning_tokens`, `attempts`, `judge_slug`, `judge_version_id`, `outcome`, `error_code`, `failure_kind`, `backoff_ms` |
| `apps/api/src/llm/index.ts` | The gateway's `finish()` funnel — one place every judge-call outcome passes through, so one place to record metrics from |
| `apps/api/src/middleware/tracing.ts` | The HTTP span, with `http.route` deliberately kept low-cardinality "so a metric can group by it". Written for this milestone |
| `apps/api/src/middleware/logger.ts` | pino → stdout NDJSON, `request_id` on every line. The input side of the Loki pipeline |
| `apps/api/src/routes/health.ts` | `/healthz` and `/readyz`. Where a `/metrics` route would sit if we scrape rather than push |
| `apps/api/src/config.ts` | Every knob is validated here; a metrics endpoint/interval variable follows the `OTEL_EXPORTER_OTLP_ENDPOINT` precedent (optional, unset is a supported state) |
| `apps/api/src/app-env.ts` | `AppDeps` is the injection seam. A `Meter` would join `tracer` here rather than being reached for globally |
| `infra/otel-collector/config.yaml` | Traces pipeline only. Header states the governing rule: *"the API talks to ONE endpoint and never to Tempo, Prometheus or (from M3) Loki directly"* |
| `infra/prometheus/prometheus.yml` | Three jobs, none of them the app. Says in its own header that M3 adds targets |
| `infra/tempo/tempo.yaml` | Closing comment: no `metrics_generator`, deferred here by name |
| `infra/grafana/provisioning/` | `datasources/` only — **no `dashboards/` directory exists yet** |
| `infra/k6/ramp.js`, `spike.js` | The load the "live dashboards during a load test" clip runs against |
| `docs/BREAKING_POINT.md` | §4 and the memory table are M3 inputs (below) |
| `apps/api/src/architecture.test.ts` | Machine-enforced ADR-0016 rules. A metrics package must not smuggle in auto-instrumentation |

## Existing patterns and constraints

**These are settled and the plan should treat them as inputs, not choices.**

- **Manual instrumentation only (ADR-0007, ADR-0016).** No auto-instrumentation, enforced by
  `architecture.test.ts` against both imports *and* `package.json` entries. Every metric is
  hand-written for the same reason every span is.
- **The app talks to one endpoint.** The collector config header is explicit that the API never
  addresses Tempo, Prometheus or Loki directly. This strongly favours **OTLP metrics → collector
  → Prometheus** over exposing `/metrics` for Prometheus to scrape. It is a stated architectural
  rule, not a preference.
- **Telemetry must degrade, never the request path.** `BatchSpanProcessor` is bounded and
  drop-on-full; pino transports are banned (CONVENTIONS "Logging") for the same reason. A metric
  reader must inherit this: a slow collector must cost telemetry, never latency.
- **Unset is a supported state (ADR-0009).** No `OTEL_EXPORTER_OTLP_ENDPOINT` → tracing still
  runs, spans go nowhere, `request_id` is still a real trace id. Metrics must behave identically;
  zero-secret boot survives.
- **`http.route`, not `url.path`, is the grouping key** (`middleware/tracing.ts`), and the span
  name is deliberately templated so a metric grouping by it does not explode.
- **`labelloop.*` for anything ours, `gen_ai.*` spelled out** (`attributes.ts`) — the same naming
  discipline applies to metric names.
- **`cost_priced` exists precisely so zero is not ambiguous.** The fake model is genuinely free;
  an unpriced model also reports zero. A cost/min panel that sums both is lying, and the
  attribute was added to make that avoidable.
- **`request_id` IS the W3C trace id (ADR-0010)** and is on every log line — which is what makes
  Grafana's trace↔logs correlation work the moment Loki exists. This is the payoff the log
  pipeline was designed for.
- **Two roles, two data stores.** M2 added Redis; the decisions log (2026-09-04) already names it
  *"a second data store to reason about at M3's observability"*.
- **Dashboards as code, in `infra/`** (ADR-0007 consequences; datasources already follow this).
  A dashboard configured by clicking exists only in one person's volume.

**Already-recorded inputs that answer questions the plan would otherwise re-open:**

- **The Loki "contradiction" is not one, and it has a pre-written instruction.** ADR-0007's
  2026-08-20 amendment states: *"BUILD_SPINE M3's 'not now: log aggregation products' means
  Datadog/Splunk/ELK-class platforms, not Loki; **amend that line when M3 is planned**."* The
  decisions log repeats it verbatim. Loki is in scope and **BUILD_SPINE M3 needs that line
  amended as part of this milestone.**
- **The alert rule already has a nominated candidate.** Decisions log 2026-08-29 on ADR-0024's
  `misconfigured` failure kind: *"the strongest candidate for M3's single alert rule, being 100%
  actionable with no false positives"* — it never self-heals, takes every judge down at once, is
  already logged at `error`, and has its own `failure_kind` span attribute so dashboards *"cannot
  conflate 'OpenRouter is flaky' with 'we did not pay the bill'"*.
- **Retention tuning was deferred here by name** (decisions log 2026-08-21): *"Dashboards, alert
  rules, and retention tuning stay in M3."* `tempo.yaml` currently sets `block_retention: 24h`
  with a comment saying the same.

**What M2 handed forward (`docs/BREAKING_POINT.md`):**

- **Tempo used ~3× the API's memory under load** — 542–569 MiB against 322–351 MiB — and it is
  the largest consumer in the stack. §4 records that the only thing that actually fell over in
  M2 was **accumulated trace state on a two-day-old stack**, OOM-killing a run. Retention and
  sizing are therefore evidence-backed M3 work, not housekeeping.
- **Tempo's `metrics_generator` is off**, which is why Grafana's Traces Drilldown answers
  `error finding generators: empty ring`. Turning it on is a two-file change (`tempo.yaml` plus
  `--web.enable-remote-write-receiver` on Prometheus) and is one of the two routes to RED metrics.
- **Soak was deferred into M3** and is why checklist row 38 stands unticked at three of four.
- **Load numbers exist to build panels against**: served p95 5.29–5.35 s, refused p95 9.5–31.9 ms,
  99.97% refusal rate, 0 errors across 1.81M requests.
- **A cost dashboard has little to show yet.** `SEED_MODEL_B`/`C` go unread after the P2 deferral,
  so the three-lab price spread is dark — the decisions log flags this as *"part of what makes
  M3's cost dashboards interesting"* and it is currently absent.

**Gaps in the governing documents themselves:**

- **CONVENTIONS.md has a "Logging" section and no metrics section.** There is no rule about metric
  naming, cardinality, or what may be a label. M3 should add one, the way logging got one.
- **`docs/BUILD_SPINE.md` M3's "Not now" line needs the ADR-0007 amendment applied.**

## Open questions for the human

1. **Where do metrics come from: the app, or Tempo's `metrics_generator`?** The generator derives
   RED metrics from spans already being sent — near-zero app change, and it fixes Drilldown. But
   it can only produce what is on a span, its cardinality is governed by span attributes, and it
   makes Tempo (already the memory hotspot) do more work. App-emitted OTLP metrics are explicit,
   cheap to keep low-cardinality, and match "every signal is deliberate" — at the cost of a new
   SDK, a second exporter and instrumentation call sites. **They are not mutually exclusive; the
   question is which is authoritative for the dashboards.**

2. **How is "per-key usage" measured?** The checklist demands a per-key panel and PRODUCT 5.10
   wants `org → panel → judge → key` drill-down. **Key id as a Prometheus label is unbounded
   cardinality** — fine at today's one seeded key, a liability at scale. Options: accept the label
   now and revisit; derive per-key usage from Postgres (`traces`/`trace_verdicts`, which is where
   M8's billing must read from anyway, since a dashboard is not an invoice); or expose it only as
   exemplars. This is the one question whose wrong answer is expensive later.

3. **What is the single alert rule, and where does it go?** `misconfigured` is pre-nominated and
   looks right. But **there is nothing deployed for it to page** — the checklist says so — and a
   notification channel needs a destination, which may mean a secret and a collision with
   ADR-0009's zero-secret boot. Is the deliverable a *firing rule visible in Grafana*, or a rule
   that actually reaches a human?

4. **Does the observability stack ship to production, or stay compose-only?** Decisions log
   2026-08-29: *"`OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately unset in production at M1, since
   the Grafana stack is compose-only and **shipping it is M3's work**."* Doing it means four more
   Railway services and real cost; not doing it means "live dashboards" is a local demo. Both are
   defensible; only one is budgeted.

5. **Is soak in M3, or deferred again?** It is the missing quarter of checklist row 38 and BUILD
   SPINE lists it nowhere. M2 deferred it here *because* the observability to watch a leak would
   exist — which only holds if the dashboards land first, making it late-M3 work if it happens.

6. **Does the cost/min panel show unpriced calls, and how?** `cost_priced=false` and a genuinely
   free fake both report zero. Two series, a filter, or a single number with a caveat — a wrong
   choice here produces a dashboard that quietly understates spend.

## Recommended approach

Input to planning, not the plan.

- **App-emitted OTLP metrics as the authoritative source**, exported through the collector to
  Prometheus — it is what the "one endpoint" rule and "every signal deliberate" both point at.
  Turn on Tempo's `metrics_generator` **as well**, cheaply, because it costs two config lines and
  makes Traces Drilldown work; just do not build the dashboards on it.
- **Instrument at the funnels that already exist**, not at new call sites: the gateway's
  `finish()` for judge-call outcome/cost/tokens/attempts, the tracing middleware's `finally` for
  HTTP duration/status, and the rate-limit middleware for allowed/refused. Three places, all of
  which already compute exactly the numbers a metric wants.
- **Keep labels low-cardinality by construction** — `http.route`, `judge_slug`, `model`, `outcome`,
  `error_code`. Resolve Q2 before any key-identifying label ships, because removing a label from a
  series later is a breaking change to every dashboard built on it.
- **Dashboards as code under `infra/grafana/provisioning/dashboards/`**, provisioned like the
  datasources so a `down -v` loses nothing.
- **Take the cheap documentation debts in the same milestone**: amend BUILD_SPINE M3's "not now"
  line per ADR-0007, and give CONVENTIONS a metrics section stating the naming and cardinality
  rules — the logging section is the model.
- **Treat Tempo retention as evidence-backed work, not tidying** — BREAKING_POINT §4 is the
  justification, and it is the one piece of M3 with a measured failure behind it.
