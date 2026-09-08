# ADR-0041: Metrics are app-emitted and authoritative; span-derived metrics are not

**Status:** Accepted · **Date:** 2026-09-08 · **Milestone:** M3
**Applies:** ADR-0007 · **Register:** STACK_DECISIONS D6 (no new row — the metrics half of OpenTelemetry)

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`. Expand if the decision is challenged or its consequences grow.

## Decision

**The API emits its own metrics through a `MeterProvider`, and those are the metrics every
dashboard is built on.** Stakeholder decision, 2026-09-08. Tempo's `metrics_generator` is
enabled alongside — it costs two configuration lines and is what makes Grafana's Traces
Drilldown work — but **no dashboard may be built on span-derived series.**

**Metrics reach Prometheus by the collector's `prometheus` exporter, which Prometheus
scrapes**, rather than by remote write. This matches the topology already in use (Prometheus
scrapes the collector for the collector's own telemetry) and preserves the rule stated in
`infra/otel-collector/config.yaml`: the API talks to ONE endpoint and never to Tempo,
Prometheus or Loki directly.

## Context

Before M3 the API emitted no application metrics at all: `otel.ts` built a tracer provider
and nothing else, and Prometheus scraped only the telemetry stack itself. Two routes existed
to close that gap — derive RED metrics from spans already being sent, or emit metrics
explicitly — and they differ in who controls cardinality and in which component does the work.

## Consequences

- **Cardinality is controlled where a metric is defined**, not inferred from whatever
  attributes a span happens to carry. That is what makes [ADR-0042](0042-per-key-usage-comes-from-postgres.md) enforceable.
- **Tempo does not take on more work.** It was already the memory hotspot in M2
  (`docs/BREAKING_POINT.md` §4: 542–569 MiB against the API's 322–351 MiB).
- Metrics follow tracing's failure posture exactly: bounded, drop-on-full, and an unset
  `OTEL_EXPORTER_OTLP_ENDPOINT` disables export without disabling the process (ADR-0009).
- Every `@opentelemetry/*` package must move as one aligned minor; the trace and metrics
  exporters share `otlp-exporter-base`.
- A second signal to keep deliberate: ADR-0007's "no span nobody chose" now applies to metrics.

Plan: `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`
Provenance: `thoughts/shared/research/2026-09-08_m3-observability.md`
Related: ADR-0007, ADR-0016, ADR-0042
