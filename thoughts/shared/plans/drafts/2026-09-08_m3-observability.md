---
date: 2026-09-08T15:40:00Z
author: claude-code
status: draft
milestone: M3
topic: m3-observability
related_adrs: [0007, 0010, 0011, 0016, 0024, 0009, 0013, 0006]
research: thoughts/shared/research/2026-09-08_m3-observability.md
---

# M3 — Observability: a second signal, its presentation, and a third

## Goal

The API emits **no application metrics at all**: `otel.ts` builds a tracer provider and
nothing else, Prometheus scrapes only the telemetry stack itself, and Grafana has two
datasources and zero dashboards. Traces are the one signal that works end to end. This plan
adds the second signal (metrics, app-emitted, through the collector), its presentation
(dashboards and one alert rule, all as code), and the third (logs to Loki, by out-of-process
collection). It closes with a soak run — the thing M2 deferred here precisely because
watching a leak needs the dashboards this milestone builds.

**Milestone: M3** (`docs/BUILD_SPINE.md`, Category 7). It completes all four Category-7 rows
in `docs/SENIORITY_CHECKLIST.md` and finishes Category-5 row 38, which has stood at three of
four scenarios since M2.

## Why four phases, and why this order

Phase 1 makes metrics exist; phase 2 can only draw what phase 1 emits. Phase 3 (logs) is
independent of both and could run in parallel, but is sequenced third so each PR stays one
signal. Phase 4 runs last **because it has to** — a soak with no dashboard is an hours-long
run nobody can watch, which is the argument M2 used to defer it here in the first place.

One branch + PR per phase, per CLAUDE.md.

## Phase 1 — the metrics pipeline

Branch: `feat/m3-p1-metrics`. PR title: `feat(api): app-emitted metrics, through the collector`.

### The SDK

- [ ] `apps/api/package.json` — add `@opentelemetry/sdk-metrics` and
      `@opentelemetry/exporter-metrics-otlp-http`. **Bump every `@opentelemetry/*` package to
      one aligned minor in the same commit**: the installed set is `sdk-trace-base@2.10.0` /
      `exporter-trace-otlp-http@0.221.0`, while the metrics packages publish at `2.11.0` /
      `0.222.0`, and the two exporters share `otlp-exporter-base`. Mixed minors across that
      shared package is the classic OTel-JS breakage.
- [ ] **No new stack row.** D6 already decides OpenTelemetry; these are the metrics half of a
      technology already chosen. `architecture.test.ts` must still pass — none of these is an
      auto-instrumentation package, and that is asserted, not assumed (ADR-0016).
- [ ] `apps/api/src/otel.ts` — a `MeterProvider` beside the tracer provider, sharing the same
      `Resource` (so `service.name`, `service.version` and `labelloop.git_sha` are identical
      across both signals — that identity is what lets a dashboard and a trace agree about
      which build they describe, ADR-0011).
- [ ] **A `PeriodicExportingMetricReader`, bounded the way the span processor is.** Telemetry
      degrades, never the request path (CONVENTIONS "Logging" states the principle; the
      `BatchSpanProcessor` config is the precedent). Export failures route to the SAME global
      error handler and `diag` bridge `startTelemetry` already installs — both, because they
      are two unrelated channels and a bridge on one leaves the likeliest failure silent.
- [ ] **Unset endpoint stays a supported state (ADR-0009).** No `OTEL_EXPORTER_OTLP_ENDPOINT`
      → no metric reader, and the process still boots and serves. Same shape as tracing.
- [ ] `apps/api/src/app-env.ts` — a `Meter` on `AppDeps`, injected exactly as `tracer` is, so
      a test substitutes it through the same seam rather than reading a global.

### The instruments, at funnels that already exist

Three call sites, chosen because each already computes the number a metric wants. **No new
instrumentation points**, which is the whole reason this milestone is small.

- [ ] `apps/api/src/middleware/tracing.ts` (its `finally`) — request duration histogram and
      request counter, labelled `http.route` and status class. The route template is already
      kept low-cardinality here *"so a metric can group by it"* — this is the metric it meant.
- [ ] `apps/api/src/llm/index.ts` (the `finish()` funnel) — judge-call duration, token counters
      (input/output/reasoning), cost counter, and attempts. Every exit passes through `finish`,
      which is why one funnel covers five outcomes.
- [ ] `apps/api/src/middleware/rate-limit.ts` — allowed/refused counter, and a counter for
      fail-open events. The last one matters: ADR-0040 says a fail-open limiter is invisible
      when it breaks, and a metric is the second half of that visibility.
- [ ] **A breaker-state gauge**, read through `ModelGateway.breakerState`, which `llm/index.ts`
      already exposes *"for the readiness and telemetry surfaces that want it"*.
- [ ] `apps/api/src/llm/attributes.ts` — metric NAMES live beside the span attribute names,
      same file, same rule: `gen_ai.*` spelled out, anything ours namespaced `labelloop.*`.

### Cardinality, stated as a rule rather than left to judgement

- [ ] **No key id, org id, panel id, trace id or artifact-derived value may ever be a metric
      label.** Per-key usage comes from Postgres (stakeholder, 2026-09-08), so the label that
      would have carried the risk is simply never created.
- [ ] `docs/CONVENTIONS.md` — **a "Metrics" section**, which the document currently lacks
      entirely. Naming, the label allow-list, the cardinality rule, and the statement that
      metrics are app-emitted and authoritative. The "Logging" section is the model.

### The pipeline

- [ ] `infra/otel-collector/config.yaml` — a metrics pipeline beside the traces one: the
      existing `otlp` receiver, the same `memory_limiter` + `batch` processors, and a
      **`prometheus` exporter on a second port**. Prometheus then SCRAPES the collector, which
      is the shape already in use (it scrapes `otel-collector:8888` for the collector's own
      telemetry) and needs no new flag on Prometheus.
- [ ] `infra/prometheus/prometheus.yml` — a scrape job for that port. The file's header already
      says *"M3 adds targets rather than a service"*; this is that.
- [ ] `infra/docker-compose.yml` — expose the collector's new metrics port on the compose
      network. No new service.
- [ ] **Tempo's `metrics_generator` is enabled too, and is explicitly NOT authoritative.** Two
      config lines plus `--web.enable-remote-write-receiver` on Prometheus. It exists so
      Grafana's Traces Drilldown stops answering `error finding generators: empty ring`; no
      dashboard in phase 2 may be built on it.

### Tests

- [ ] `apps/api/src/otel.test.ts` — the meter provider is created, shares the tracer's
      Resource, and is absent when the endpoint is unset. Extends the existing file's pattern.
- [ ] `apps/api/src/metrics.test.ts` (or beside each funnel) — the instruments record on the
      paths that produce them: a request records duration once, a judge call records cost and
      tokens, a refused request increments the refusal counter, a fail-open increments its own.
- [ ] **A cardinality test.** Assert that no recorded metric carries a label from the banned
      list. This is the one rule whose violation is silent, cheap to introduce and expensive to
      remove — a label cannot be dropped later without breaking every dashboard built on it.

### Automated verification

- [ ] `bun run lint`, `bun run typecheck`, `bun test` all green.
- [ ] `docker compose -f infra/docker-compose.yml up -d --wait` healthy.
- [ ] `curl` the collector's metrics port and see `labelloop_*` series.
- [ ] Prometheus reports the new scrape job UP, and the app series are queryable.

### Manual verification

- [ ] Drive some traffic; confirm request, judge-call, cost and rate-limit series all move.
- [ ] Stop the collector; confirm the API keeps serving and warns rather than erroring.

## Phase 2 — dashboards and the one alert rule

Branch: `feat/m3-p2-dashboards`. PR title: `feat(grafana): dashboards as code, and one alert rule`.

- [ ] `infra/grafana/provisioning/dashboards/` — **the directory does not exist yet.** A
      provider YAML plus dashboard JSON, mounted read-only exactly as `datasources/` is, so a
      `docker compose down -v` loses nothing and no dashboard exists only in one person's volume.
- [ ] **Service dashboard**: request rate, error rate, and p50/p95/p99 by route. The p95 numbers
      to sanity-check against are in `docs/BREAKING_POINT.md` (served 5.29–5.35 s, refused
      9.5–31.9 ms).
- [ ] **Judge dashboard**: calls by model and outcome, latency by judge, attempts, breaker state,
      tokens.
- [ ] **Cost dashboard**: cost/min, **two series split on `cost_priced`**. A single sum would
      fold genuinely-free fake calls and unpriced-model calls into real spend and understate it;
      the attribute exists precisely so a zero is not ambiguous. *(Planner's call, flagged in the
      research — say so if one number with a caveat is preferred.)*
- [ ] **Per-key usage, queried from Postgres** (stakeholder, 2026-09-08) — see the open question
      below about which role Grafana connects as, which must be settled before this ships.
- [ ] **One alert rule: `misconfigured`**, pre-nominated by the decisions log on 2026-08-29 as
      *"100% actionable with no false positives"* — it never self-heals, takes every judge down
      at once, and already has its own `failure_kind` attribute so a dashboard cannot conflate
      "the provider is flaky" with "we did not pay the bill".
- [ ] **Grafana-visible only, no notification channel** (stakeholder, 2026-09-08). A destination
      would need a credential and would break ADR-0009's zero-secret boot. The deliverable is a
      rule that visibly fires.

### Automated verification

- [ ] Dashboards provision from a cold `down -v` / `up` with no manual step.
- [ ] Every panel returns data rather than "No data" after a short k6 smoke.
- [ ] The alert rule loads and evaluates.

### Manual verification

- [ ] Drive the fake into `misconfigured` and watch the rule fire in Grafana.
- [ ] Run a ramp and watch the dashboards — **this is the checklist's "recorded clip"**.

## Phase 3 — logs, and the line ADR-0007 told us to amend

Branch: `feat/m3-p3-logs`. PR title: `feat(infra): logs to Loki, by out-of-process collection`.

- [ ] `infra/docker-compose.yml` — a `loki` service, pinned (`grafana/loki:3.6.2`, confirmed to
      exist), with a volume. **No new stack row**: ADR-0007 states Loki *"needs no new stack row
      — it is inside D6's self-hosted Grafana stack"*.
- [ ] `infra/otel-collector/config.yaml` — a **filelog receiver** reading Docker's container
      logs, and a logs pipeline exporting to Loki. **The app ships nothing** — pino writes NDJSON
      to stdout and the platform owns delivery (ADR-0007's amendment, CONVENTIONS' "zero pino
      transports, ever"). Verified as feasible on this host: a container can read
      `/var/lib/docker/containers/*/*-json.log`.
- [ ] `infra/grafana/provisioning/datasources/loki.yaml` — with **`derivedFields` linking
      `request_id` to Tempo**. This is the payoff ADR-0010 was designed for: `request_id` IS the
      W3C trace id and is on every log line, so a log jumps to its trace in one click.
- [ ] `docs/BUILD_SPINE.md` — **amend M3's "Not now: log aggregation products" line.** ADR-0007
      instructs this by name: it means Datadog/Splunk/ELK-class platforms, not Loki, and the
      amendment was explicitly deferred to *"when M3 is planned"*.

### Automated verification

- [ ] `bun test` untouched — no application code changes in this phase.
- [ ] Logs from the `api` container are queryable in Loki within seconds of a request.

### Manual verification

- [ ] From a log line in Grafana, click through to its trace in Tempo. That round trip is the
      whole reason the log pipeline is out-of-process rather than in-process.

## Phase 4 — soak, retention, and closing M3

Branch: `feat/m3-p4-soak`. PR title: `feat(k6): a soak, and retention sized from what it shows`.

- [ ] `infra/k6/soak.js` — a long, low-rate run on the shared `load-lib.js`, using the same
      judge-latency guard. Deliberately BELOW the rate limit so the evaluation path is actually
      exercised: a soak of 429s would measure nothing, which is the trap `ramp.js` documents.
- [ ] Run it, watching phase 2's dashboards. **This is the ordering the whole plan is built
      around** — M2 deferred soak here so a leak would be visible while it happened.
- [ ] `infra/tempo/tempo.yaml` — retention tuned from evidence. `BREAKING_POINT.md` §4 is the
      justification: Tempo used **542–569 MiB against the API's 322–351 MiB**, and the only thing
      that actually fell over in M2 was accumulated trace state on a two-day-old stack. Retention
      tuning was deferred here by name on 2026-08-21.
- [ ] `docs/BREAKING_POINT.md` — a soak section, and **§6 updated**: "no soak" is one of its
      named gaps and stops being true. §8's list of what would make v1 worth reading loses an item.
- [ ] `docs/SENIORITY_CHECKLIST.md` — Category 7's four rows, and **Category 5 row 38**, which has
      stood at three of four since M2 and now has its fourth scenario.

### Automated verification

- [ ] `bun test` green; the soak script parses and its thresholds can fail.

### Manual verification

- [ ] Memory flat across the soak, or a leak identified. **Either is a publishable result** —
      finding one is a better outcome than not looking (CLAUDE.md: honest results over impressive).

## Decisions made

- **Metrics are app-emitted and authoritative; Tempo's `metrics_generator` is enabled but no
  dashboard is built on it.** Stakeholder, 2026-09-08. App-emitted matches ADR-0007's "every
  signal deliberate" and keeps cardinality controllable at the point of definition; the generator
  costs two config lines and fixes Traces Drilldown, so it is turned on rather than argued about.
- **Metrics reach Prometheus by the collector's `prometheus` exporter, scraped** — not by
  remote-write. It matches the shape already in use (Prometheus scrapes the collector today) and
  preserves the collector config's stated rule that the API talks to ONE endpoint and never to
  Prometheus directly. *(Remote-write gets enabled anyway for Tempo's generator; the app path
  still does not use it.)*
- **Per-key usage is queried from Postgres, and no key-identifying label ever enters a metric
  series.** Stakeholder, 2026-09-08. This removes the unbounded-cardinality risk outright rather
  than deferring it, and it points the panel at the same source M8's billing must read from — a
  dashboard is not an invoice.
- **A cardinality rule in CONVENTIONS, plus a test that enforces it.** The rule's violation is
  silent and its reversal is breaking: a label cannot be removed later without breaking every
  dashboard built on it. Machine-enforced, in the spirit of ADR-0016.
- **One alert rule, on `misconfigured`, visible in Grafana only.** Stakeholder, 2026-09-08. The
  condition was pre-nominated on 2026-08-29; the no-channel choice keeps ADR-0009's zero-secret
  boot intact, and nothing is deployed to page anyway.
- **The observability stack stays compose-only.** Stakeholder, 2026-09-08. **The cost, recorded
  rather than glossed: nothing observes the deployed API**, and shipping the stack later is its
  own change with its own budget. Grafana is anonymous-admin today and could not ship as-is.
- **All `@opentelemetry/*` packages move to one aligned minor.** The two exporters share
  `otlp-exporter-base`; mixed minors across it is the classic OTel-JS breakage.
- **Cost/min shows two series split on `cost_priced`.** Planner's call, flagged for review: a
  single sum folds genuinely-free and unpriced calls into real spend and understates it.
- **Soak runs last, after the dashboards.** Stakeholder, 2026-09-08, and the ordering M2's
  deferral assumed.
- **Instrumentation reuses the three funnels that already exist** rather than adding call sites.

## Explicitly NOT doing

- **Shipping the Grafana stack to production.** Settled above; it is its own change.
- **Any notification channel** — no PagerDuty, Slack, email or webhook. No credential, no
  zero-secret-boot collision.
- **Log aggregation PRODUCTS** — Datadog, Splunk, ELK. This is what BUILD_SPINE M3's "not now"
  line actually meant, and the amendment says so.
- **SLO tooling, error budgets, burn-rate alerts.** BUILD_SPINE's own "not now" for M3.
- **Sampling.** `AlwaysOnSampler` stays: ADR-0001 captures 100% of judge calls, and a sampler
  would argue with it. Volume is bounded by the queue instead.
- **Per-org or billing dashboards.** PRODUCT 5.10's two-sided financial view is M8.
- **Touching the error taxonomy, the breaker, or the limiter.** M3 observes; it does not change
  behaviour. If a dashboard suggests a threshold is wrong, that is a finding for its own change.
- **Auto-instrumentation**, in any form, forever (ADR-0016, machine-enforced).

## Open questions

1. **Which database role does Grafana connect as for the per-key panel?** The per-key decision
   points Grafana at Postgres, and CONVENTIONS states a **two-role** invariant: a migrator that
   owns DDL and an app role holding DML only. Grafana needs neither — it needs SELECT. Options:
   **(a)** a third `labelloop_readonly` role with SELECT and `ALTER DEFAULT PRIVILEGES`, added by
   a forward-only migration — correct, and it amends a stated convention; **(b)** reuse the app
   role — no migration, but hands a dashboard a credential that can INSERT and DELETE, which is
   exactly the reasoning the two-role split exists to make impossible. **(a) is recommended** and
   would make CONVENTIONS' "Data rules" say three roles. It needs a human call because it changes
   a documented invariant, and because a new role is a migration in a package whose migrations
   are forward-only.

2. **Does the per-key panel need a `traces` index it does not have?** Grouping by key over a
   growing table is a dashboard query on the hot path's own database. Worth confirming an index
   exists before the panel ships, or the friendliest dashboard in the repo becomes the slowest
   query against production data.

3. **Is a metric-name prefix of `labelloop_` right for Prometheus**, given spans use dotted
   `labelloop.*`? Prometheus convention is `snake_case` with underscores and the OTel exporter
   translates dots automatically. Naming it explicitly avoids two conventions drifting.
