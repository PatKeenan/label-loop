# ADR-0007: Manual OTel instrumentation; Sentry is reporting, not handling

**Status:** Accepted (amended 2026-08-20: log delivery path made explicit) · **Date:** 2026-08-19

## Decision
OpenTelemetry via explicit Hono middleware + the single `llm/` module (span per
request, span per provider call with token/cost attributes), exported to a self-hosted
Grafana observability stack running as containers. Sentry (free tier) receives
unexpected errors only. Error HANDLING is a code-level pattern owned by us
(CONVENTIONS.md: closed error taxonomy, AppError classes, one central handler);
Sentry is strictly the reporting sink at the end of that pipeline.

## Amendment 2026-08-20 — how logs reach aggregation
Logs are a third signal, delivered differently from traces and metrics. The app never
ships them: pino writes raw NDJSON to stdout and an out-of-process collector (the OTel
Collector's filelog receiver) reads container stdout and exports to Loki from M3.
In-process pino transports are banned (CONVENTIONS.md) because they couple API
availability to the log backend and lose buffered lines on crash — 12-factor XI, and
the container-native norm.

The asymmetry with traces/metrics is principled: spans have no stdout convention, so
the OTel SDK exports them in-process over OTLP with a bounded, drop-on-full batch
processor. Logs have a universal stdout convention, so the platform owns delivery.

Loki needs no new stack row — it is inside D6's "self-hosted Grafana stack". Note that
BUILD_SPINE M3's "not now: log aggregation products" means Datadog/Splunk/ELK-class
platforms, not Loki; amend that line when M3 is planned.

## Context
Bun's OTel auto-instrumentation is patchier than Node's; manual instrumentation is
more work but demonstrates deeper skill and keeps spans intentional.

## Consequences
- Every span attribute is deliberate; no auto-instrumentation noise.
- Dashboards-as-code live in infra/ and deploy with compose.
