---
date: 2026-09-08T15:40:00Z
author: claude-code
status: approved
approved_at: 2026-09-08T16:05:00Z
approved_by: pat
milestone: M3
topic: m3-observability
related_adrs: [0041, 0042, 0043, 0044, 0045, 0007, 0010, 0011, 0016, 0024, 0009, 0013, 0006]
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

## Why five phases, and why this order

Phase 1 makes metrics exist; phase 3 can only draw what phase 1 emits. **Phase 2 sits between
them because the per-key panel needs a database credential that does not exist yet**, and a
privilege migration is a different review surface from dashboard JSON — mixing them would ask
one reviewer to check Postgres grants and Grafana panels in the same diff. Phase 4 (logs) is
independent of all three and could run in parallel, but is sequenced late so each PR carries one
signal. Phase 5 runs last **because it has to** — a soak with no dashboard is an hours-long run
nobody can watch, which is the argument M2 used to defer it here in the first place.

One branch + PR per phase, per CLAUDE.md.

## Phase 1 — the metrics pipeline

Branch: `feat/m3-p1-metrics`. PR title: `feat(api): app-emitted metrics, through the collector`.

### The SDK

- [x] `apps/api/package.json` — add `@opentelemetry/sdk-metrics` and
      `@opentelemetry/exporter-metrics-otlp-http`. **Bump every `@opentelemetry/*` package to
      one aligned minor in the same commit**: the installed set is `sdk-trace-base@2.10.0` /
      `exporter-trace-otlp-http@0.221.0`, while the metrics packages publish at `2.11.0` /
      `0.222.0`, and the two exporters share `otlp-exporter-base`. Mixed minors across that
      shared package is the classic OTel-JS breakage.
- [x] **No new stack row.** D6 already decides OpenTelemetry; these are the metrics half of a
      technology already chosen. `architecture.test.ts` must still pass — none of these is an
      auto-instrumentation package, and that is asserted, not assumed (ADR-0016).
- [x] `apps/api/src/otel.ts` — a `MeterProvider` beside the tracer provider, sharing the same
      `Resource` (so `service.name`, `service.version` and `labelloop.git_sha` are identical
      across both signals — that identity is what lets a dashboard and a trace agree about
      which build they describe, ADR-0011).
- [x] **A `PeriodicExportingMetricReader`, bounded the way the span processor is.** Telemetry
      degrades, never the request path (CONVENTIONS "Logging" states the principle; the
      `BatchSpanProcessor` config is the precedent). Export failures route to the SAME global
      error handler and `diag` bridge `startTelemetry` already installs — both, because they
      are two unrelated channels and a bridge on one leaves the likeliest failure silent.
- [x] **Unset endpoint stays a supported state (ADR-0009).** No `OTEL_EXPORTER_OTLP_ENDPOINT`
      → no metric reader, and the process still boots and serves. Same shape as tracing.
- [x] `apps/api/src/app-env.ts` — a `Meter` on `AppDeps`, injected exactly as `tracer` is, so
      a test substitutes it through the same seam rather than reading a global.

### The instruments, at funnels that already exist

Three call sites, chosen because each already computes the number a metric wants. **No new
instrumentation points**, which is the whole reason this milestone is small.

- [x] `apps/api/src/middleware/tracing.ts` (its `finally`) — request duration histogram and
      request counter, labelled `http.route` and status class. The route template is already
      kept low-cardinality here *"so a metric can group by it"* — this is the metric it meant.
- [x] `apps/api/src/llm/index.ts` (the `finish()` funnel) — judge-call duration, token counters
      (input/output/reasoning), cost counter, and attempts. Every exit passes through `finish`,
      which is why one funnel covers five outcomes.
- [x] `apps/api/src/middleware/rate-limit.ts` — allowed/refused counter, and a counter for
      fail-open events. The last one matters: ADR-0040 says a fail-open limiter is invisible
      when it breaks, and a metric is the second half of that visibility.
- [x] **A breaker-state gauge**, read through `ModelGateway.breakerState`, which `llm/index.ts`
      already exposes *"for the readiness and telemetry surfaces that want it"*.
- [x] `apps/api/src/llm/attributes.ts` — metric NAMES live beside the span attribute names,
      same file, same rule: `gen_ai.*` spelled out, anything ours namespaced `labelloop.*`.

### Cardinality, stated as a rule rather than left to judgement

- [x] **No key id, org id, panel id, trace id or artifact-derived value may ever be a metric
      label.** Per-key usage comes from Postgres (stakeholder, 2026-09-08), so the label that
      would have carried the risk is simply never created.
- [x] `docs/CONVENTIONS.md` — **a "Metrics" section**, which the document currently lacks
      entirely. Naming, the label allow-list, the cardinality rule, and the statement that
      metrics are app-emitted and authoritative. The "Logging" section is the model.

### The pipeline

- [x] `infra/otel-collector/config.yaml` — a metrics pipeline beside the traces one: the
      existing `otlp` receiver, the same `memory_limiter` + `batch` processors, and a
      **`prometheus` exporter on a second port**. Prometheus then SCRAPES the collector, which
      is the shape already in use (it scrapes `otel-collector:8888` for the collector's own
      telemetry) and needs no new flag on Prometheus.
- [x] `infra/prometheus/prometheus.yml` — a scrape job for that port. The file's header already
      says *"M3 adds targets rather than a service"*; this is that.
- [x] `infra/docker-compose.yml` — expose the collector's new metrics port on the compose
      network. No new service.
- [x] **Tempo's `metrics_generator` is enabled too, and is explicitly NOT authoritative.** Two
      config lines plus `--web.enable-remote-write-receiver` on Prometheus. It exists so
      Grafana's Traces Drilldown stops answering `error finding generators: empty ring`; no
      dashboard in phase 2 may be built on it.

### Tests

- [x] `apps/api/src/otel.test.ts` — the meter provider is created, shares the tracer's
      Resource, and is absent when the endpoint is unset. Extends the existing file's pattern.
- [x] `apps/api/src/metrics.test.ts` (or beside each funnel) — the instruments record on the
      paths that produce them: a request records duration once, a judge call records cost and
      tokens, a refused request increments the refusal counter, a fail-open increments its own.
- [x] **A cardinality test.** Assert that no recorded metric carries a label from the banned
      list. This is the one rule whose violation is silent, cheap to introduce and expensive to
      remove — a label cannot be dropped later without breaking every dashboard built on it.

### Automated verification

- [x] `bun run lint`, `bun run typecheck`, `bun test` all green.
- [x] `docker compose -f infra/docker-compose.yml up -d --wait` healthy.
- [x] `curl` the collector's metrics port and see `labelloop_*` series.
- [x] Prometheus reports the new scrape job UP, and the app series are queryable.

### Manual verification

- [ ] Drive some traffic; confirm request, judge-call, cost and rate-limit series all move.
- [ ] Stop the collector; confirm the API keeps serving and warns rather than erroring.

## Phase 2 — a read-only role, so a dashboard cannot write

Branch: `feat/m3-p2-readonly-role`. PR title: `feat(db): a read-only role for the dashboards`.

**Why this exists.** Per-key usage is read from Postgres (stakeholder, 2026-09-08), so Grafana
needs a credential. Neither existing role is right: the migrator owns DDL and the app role holds
DML, and handing a dashboard the ability to `INSERT` or `DELETE` is exactly what the two-role
split exists to make impossible. A third role that can only `SELECT` is the smallest thing that
answers the question.

- [x] `scripts/db-bootstrap.ts` — create `labelloop_readonly`. The only step that needs a
      superuser, which is why role creation already lives here and not in a migration.
- [x] `packages/db/migrations/0010_readonly_role.sql` — **both halves, and the second is the one
      that is easy to forget.** `GRANT SELECT ON ALL TABLES` covers the tables that already exist;
      `ALTER DEFAULT PRIVILEGES ... GRANT SELECT` covers every table a later migration adds.
      `0000_privileges.sql` already documents this exact trap for `drizzle.__drizzle_migrations`
      — default privileges only ever cover objects created *after* they are set, and a role added
      at migration 10 is on the wrong side of every table created in 1 through 9.
- [x] **`audit_events` stays readable but never writable**, which it already is for this role by
      construction: the readonly grant is SELECT only, so ADR's append-only invariant needs no
      special case here. Worth asserting anyway, because "by construction" is what tests are for.
- [x] `packages/db/src/roles.test.ts` — extend the existing suite: the readonly role **can**
      SELECT from a representative table, and **cannot** INSERT, UPDATE, DELETE, or issue DDL.
      Asserted on SQLSTATE `42501`, matching how `queue.test.ts` and the audit tests already do it.
- [x] `docs/CONVENTIONS.md` — **"Data rules" says two roles; it becomes three.** The addition is
      recorded with its reason: a credential handed to a dashboard must not be able to write, and
      the invariant is enforced by grants rather than by trusting the dashboard.
- [x] `.env.example` — a `DATABASE_READONLY_URL` row, exhaustive per the "Config" rule, with the
      same self-describing `localdev` placeholder the other connection strings use.
- [x] `infra/docker-compose.yml` — the connection string on the `grafana` service only. **Not on
      `api`**: `config.ts` must not be able to express this credential, for the same reason it
      cannot express the migrator's — a role the API cannot name is a role a bug cannot use.

### Automated verification

- [x] `bun run db:setup` from scratch creates all three roles and applies the migration.
- [x] `bun test` green, including the new privilege assertions.
- [x] A `down -v` / `up` cycle reproduces the role without a manual step.

### Manual verification

- [ ] Connect as `labelloop_readonly` and confirm a `SELECT` works and an `INSERT` is refused.

## Phase 3 — dashboards and the one alert rule

Branch: `feat/m3-p3-dashboards`. PR title: `feat(grafana): dashboards as code, and one alert rule`.

- [x] `infra/grafana/provisioning/dashboards/` — **the directory does not exist yet.** A
      provider YAML plus dashboard JSON, mounted read-only exactly as `datasources/` is, so a
      `docker compose down -v` loses nothing and no dashboard exists only in one person's volume.
- [x] **Service dashboard**: request rate, error rate, and p50/p95/p99 by route. The p95 numbers
      to sanity-check against are in `docs/BREAKING_POINT.md` (served 5.29–5.35 s, refused
      9.5–31.9 ms).
- [x] **Judge dashboard**: calls by model and outcome, latency by judge, attempts, breaker state,
      tokens.
- [x] **Cost dashboard**: cost/min, **two series split on `cost_priced`**. A single sum would
      fold genuinely-free fake calls and unpriced-model calls into real spend and understate it;
      the attribute exists precisely so a zero is not ambiguous. *(Planner's call, flagged in the
      research — say so if one number with a caveat is preferred.)*
- [x] **Per-key usage, queried from Postgres** (stakeholder, 2026-09-08), through a Grafana
      Postgres datasource provisioned as code and connecting as **`labelloop_readonly`** (phase 2).
      Grouped by key id, which is safe here in a way it would never be as a metric label: a SQL
      `GROUP BY` costs a query, while a Prometheus label costs a time series forever.
- [x] **One alert rule: `misconfigured`**, pre-nominated by the decisions log on 2026-08-29 as
      *"100% actionable with no false positives"* — it never self-heals, takes every judge down
      at once, and already has its own `failure_kind` attribute so a dashboard cannot conflate
      "the provider is flaky" with "we did not pay the bill".
- [x] **Grafana-visible only, no notification channel** (stakeholder, 2026-09-08). A destination
      would need a credential and would break ADR-0009's zero-secret boot. The deliverable is a
      rule that visibly fires.

### Automated verification

- [x] Dashboards provision from a cold `down -v` / `up` with no manual step.
- [x] Every panel returns data rather than "No data" after a short k6 smoke.
- [x] The alert rule loads and evaluates.

### Manual verification

- [ ] Drive the fake into `misconfigured` and watch the rule fire in Grafana.
- [ ] Run a ramp and watch the dashboards — **this is the checklist's "recorded clip"**.

## Phase 4 — logs, and the line ADR-0007 told us to amend

Branch: `feat/m3-p4-logs`. PR title: `feat(infra): logs to Loki, by out-of-process collection`.

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

## Phase 5 — soak, retention, and closing M3

Branch: `feat/m3-p5-soak`. PR title: `feat(k6): a soak, and retention sized from what it shows`.

- [ ] `infra/k6/soak.js` — a long, low-rate run on the shared `load-lib.js`, using the same
      judge-latency guard. Deliberately BELOW the rate limit so the evaluation path is actually
      exercised: a soak of 429s would measure nothing, which is the trap `ramp.js` documents.
- [ ] Run it, watching phase 3's dashboards. **This is the ordering the whole plan is built
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
- **A third database role, `labelloop_readonly`, and CONVENTIONS' two-role invariant becomes
  three.** Stakeholder, 2026-09-08. Neither existing role is right for a dashboard: one owns DDL,
  the other can write. The alternative — reusing the app role — would hand a Grafana datasource a
  credential that can `INSERT` and `DELETE`, which is precisely the capability the migrator/app
  split exists to withhold. It gets its own phase because a privilege migration and a dashboard
  JSON are different review surfaces.
- **The readonly credential is given to Grafana and withheld from the API.** `config.ts` must not
  be able to express it, matching how the migrator credential is already kept out of the API's
  config schema: a role the API cannot name is a role a bug cannot reach for.
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

## Deviations

Recorded as they happen, because they are decision provenance too (CLAUDE.md).

### Phase 1

- **Open question 3 answered: OTel-dotted metric names, not Prometheus-underscored.**
  Instruments are named `labelloop.judge.cost_usd` and `http.server.request.duration`, and
  the collector's `prometheus` exporter translates them to `labelloop_judge_cost_usd_total`
  and `http_server_request_duration_seconds_bucket` on the way out. Each convention then
  stays correct on its own side of the collector, rather than one leaking into the other,
  and it keeps the metric names spelled the same way as the span attribute names they sit
  beside. Verified against the running exporter's output, not assumed.
- **`unit: 'USD'` was removed from the cost counter after reading the exporter's output.**
  The OTLP-to-Prometheus translation APPENDS the unit to the name, so the declared unit
  published `labelloop_judge_cost_usd_USD_total`. The name carries the unit instead. The
  token counters keep `{token}`, which is a UCUM annotation the same translation correctly
  omits. This is exactly the class of thing that is invisible until you look at the wire.
- **The metric reader's export timeout is 8s, not the span processor's 30s.** The SDK
  refuses a timeout longer than the export interval, and rightly: an export still running
  when the next is due either overlaps itself or skips a window. Same posture, different
  number, for a different reason.
- **`createBreakerRegistry` gained a `states()` accessor.** The plan says the breaker gauge
  is read through `ModelGateway.breakerState`, which takes a model — but an OBSERVABLE
  gauge has to enumerate the models that have breakers, and only the registry knows them,
  since a breaker is created lazily on first call. Three lines, inside `llm/`.
- **A second metric instrument name file was not created.** Judge metric names went into
  `llm/attributes.ts` as the plan says; the HTTP and rate-limit names went into the new
  `metrics.ts`, which also builds every instrument from an injected `Meter` and memoises
  them per meter. The `Meter` is the seam on `AppDeps`, as planned.
- **The global export-failure log message changed** from "span export failed" to
  "telemetry export failed — spans or metrics are being dropped". Both the batch span
  processor and the periodic metric reader report to that one handler, so naming one of
  them would have mislabelled the other.
- **`resource_to_telemetry_conversion` is left OFF on the collector's prometheus
  exporter**, with `target_info` as the documented join for build identity. Enabling it
  would copy `service.version` and `labelloop.git_sha` onto every series and multiply the
  series set on each deploy — which would be an odd thing to do inside the milestone that
  writes down a cardinality rule.

### Phase 2

- **The `traces` index moved from phase 3 into this phase.** Stakeholder, on being told
  open question 2's answer. `traces.api_key_id` has existed since `0001_initial_schema.sql`
  with a foreign key and NO index, and none of the three indexes on that table
  (`org_id, created_at`, `panel_id, created_at`, `request_id`) can serve a
  `GROUP BY api_key_id` over a time window — so the per-key panel would have table-scanned
  the hot path's own database every fifteen seconds. It ships in `0010` with the grants.
- **Open question 2 is therefore ANSWERED: yes, it needed one, and it now has one.**
  `(api_key_id, created_at)`, verified against 200k rows over 8 keys rather than reasoned
  about — Postgres 18.6 skip-scans the leading column, so `EXPLAIN` shows a Bitmap Index
  Scan on this index with `Index Cond: (created_at > ...)` and no leading-column condition
  at all. One index serves both the panel's group-by-over-a-window and an ordinary
  single-key lookup. On a Postgres older than 18 the columns would want reversing.
- **`bootstrapRoles` gained a fourth parameter**, `readonlyUrl`, and `db:bootstrap` a third
  `requireEnv`. Unavoidable given the existing design: bootstrap derives each role's
  password FROM its connection string, deliberately, so the strings stay the single source
  of truth. A third role means a third string.
- **The `migrate` service holds `DATABASE_READONLY_URL` as well as `grafana`.** The plan
  says "the connection string on the `grafana` service only. **Not on `api`**" — the second
  half is honoured exactly, and the first needed one addition, because the one-shot that
  runs `db:bootstrap` is what sets the role's password and so must be given the string. That
  matches what the compose file already says about that service: it "holds all three
  connection strings and the API below holds exactly one". Now four and one.
- **No grant on the `drizzle` schema for the readonly role.** The app role reads
  `__drizzle_migrations` because `/readyz` reports whether migrations are current; a
  dashboard has no such question. Stated in the migration so it reads as a decision rather
  than an omission.
- **Two separate tests for the two halves of the grant**, rather than one. They fail
  independently — drop the explicit `GRANT SELECT ON ALL TABLES` and only the
  before-the-role table breaks; drop the default privileges and only the after one does —
  so a single test would hide exactly the trap ADR-0045 warns about.
- **`.env.example` gained the row, and a local `.env` needs it too.** `bun run db:setup`
  fails by name without it, which is the intended behaviour (CONVENTIONS "Config") but is
  worth saying out loud: anyone pulling this branch re-copies the row or re-runs setup.

### Phase 3

- **Two labels added to phase 1's judge instruments, both stakeholder-approved.**
  `labelloop.failure_kind` (five bounded values, failures only) and `labelloop.cost_priced`
  moved onto the token counters. CONVENTIONS' label allow-list is amended for both.
- **The alert rule could not have been built without `failure_kind`, and this was found by
  trying.** ADR-0043 says `misconfigured` "already has its own `failure_kind` attribute" —
  true of the SPAN, not the metric. On the metrics as phase 1 shipped them, every timeout,
  503, open circuit and unpaid bill sat in one `outcome="error"` bucket, and the taxonomy
  code did not separate them either since `misconfigured` maps to `INTERNAL` alongside an
  adapter bug. The rule's "100% actionable, no false positives" claim was unbuildable.
- **`failure_kind` is now set on the judge SPAN too, in the same place.** Previously only
  the circuit-open path set it at judge level, so a Tempo search for misconfigured judges
  found nothing at the level carrying the judge and its version — which is exactly the
  drill-down an alert wants. Span and metric now take the value from one argument, so they
  cannot disagree.
- **The fake gained a `__misconfigured__` sentinel.** The plan's own manual verification is
  "drive the fake into `misconfigured` and watch the rule fire", and there was no way to do
  it — the fake had sentinels for unavailable, invalid-output and slow only. A rule nobody
  can trigger is a rule nobody has tested. Same argument the existing sentinels are built
  on: a failure drivable by hand with `curl` is one that can be shown working.
- **Per-key usage is a panel on the COST dashboard rather than a fourth dashboard.** The
  plan lists it as its own bullet without saying where it lives; "who is using this" and
  "what does it cost" are the same question asked twice.
- **Phase 2's `DATABASE_READONLY_URL` on the `grafana` service was replaced with fields.**
  Grafana's Postgres datasource is provisioned with host, database, user and password as
  separate keys and has nowhere to put a connection string. My wrong assumption in phase 2;
  the role and its grants are unaffected.
- **The cost/min question is settled the third way, not either way the plan offered.**
  Neither one summed number nor two series: the money line FILTERS to `cost_priced="true"`
  so it says what it measures, and a companion stat sizes the blind spot in TOKENS. The
  reason is that an unpriced call records a cost of zero, so a cost series split on the
  label has a `false` line that is flat zero forever — it proves a blind spot exists and
  cannot measure it. Tokens are roughly proportional to spend, so they can.
- **Four panels returned "No data" on first assembly and one was a real bug.** "Cost per
  verdict" divided series grouped by `gen_ai_response_model`, which the calls counter does
  not carry — two disjoint label sets, matching nothing. Regrouped on
  `gen_ai_request_model`, which both carry. The other three were the HEALTHY state
  rendering as "No data"; the two that must read zero rather than blank (`fail-open events`
  and `unpriced tokens`) now use `or vector(0)`.
- **The per-key query plans as a Seq Scan today, and that is correct.** `traces` holds 74
  rows on a demo stack, where a sequential scan beats an index. Phase 2's
  `(api_key_id, created_at)` was verified on a 200k-row probe, which is the size at which
  the question is real. Recorded so nobody reads a local `EXPLAIN` as the index being dead.
- **No notification channel and no contact point were provisioned** (ADR-0043). Grafana's
  built-in default receives the alert and does nothing, which is the intended end state.

## Open questions

1. ~~**Which database role does Grafana connect as for the per-key panel?**~~ **ANSWERED —
   option (a), a third `labelloop_readonly` role.** Stakeholder, 2026-09-08. It gets **Phase 2 of
   its own** rather than riding inside the dashboards PR: a Postgres privilege migration and a
   dashboard JSON are different kinds of risk, and the repo already treats privilege changes as
   first-class with dedicated tests (`roles.test.ts`, `0002_audit_append_only.sql`). CONVENTIONS'
   "Data rules" is amended from two roles to three, and the reason the third exists — a dashboard
   credential must not be able to write — is recorded with it.

2. ~~**Does the per-key panel need a `traces` index it does not have?**~~ **ANSWERED — yes,
   and it now has one.** There was no index on `api_key_id` at all. `(api_key_id, created_at)`
   ships in PHASE 2's migration rather than phase 3 (stakeholder), verified by `EXPLAIN`
   against 200k rows: Postgres 18.6 skip-scans the leading column, so the same index serves
   the panel's group-by-over-a-window and an ordinary single-key lookup.

3. ~~**Is a metric-name prefix of `labelloop_` right for Prometheus**, given spans use dotted
   `labelloop.*`?~~ **ANSWERED in phase 1 — instruments are named OTel-dotted and the
   collector translates.** Each convention stays correct on its own side of the collector,
   and the metric names are spelled the same way as the span attribute names beside them.
   Verified against the exporter's real output, which also caught `unit: 'USD'` publishing
   `labelloop_judge_cost_usd_USD_total`.
