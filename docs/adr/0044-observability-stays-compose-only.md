# ADR-0044: The observability stack stays compose-only; nothing observes production

**Status:** Accepted · **Date:** 2026-09-08 · **Milestone:** M3
**To be revisited at:** M8 (deploy)

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`. Expand if the decision is challenged or its consequences grow.

## Decision

**The collector, Tempo, Prometheus, Loki and Grafana run in compose only. They are not deployed
to production at M3.** Stakeholder decision, 2026-09-08. `OTEL_EXPORTER_OTLP_ENDPOINT` stays
unset in production, which is already a supported state (ADR-0009): the tracer still runs and
`request_id` is still a real W3C trace id (ADR-0010).

## Context

The decisions log recorded on 2026-08-29 that the endpoint is *"deliberately unset in production
at M1, since the Grafana stack is compose-only and **shipping it is M3's work**"*. M3 declines
that work rather than inheriting it silently.

## Consequences

- **The cost, recorded rather than glossed: nothing observes the deployed API.** There are no
  production dashboards, no production traces, and the one alert rule fires only against a local
  stack. This is a real gap, not a technicality.
- `docs/SENIORITY_CHECKLIST.md`'s "live dashboards during a load test" is satisfied by a local
  recorded clip, which is what the row asks for.
- **Grafana could not ship as-is regardless.** It runs anonymous-admin with the login form
  disabled — correct for a throwaway local stack, unacceptable on a public URL — so shipping it
  is a larger change than adding services.
- Four more Railway services and volumes are avoided, on top of Railway Pro (D10).
- **M8 should revisit this with the deploy**, where a production alert has somewhere to go.

Plan: `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`
Provenance: `thoughts/shared/research/2026-09-08_m3-observability.md`
Related: ADR-0009, ADR-0010, ADR-0043, ADR-0013 · Register: D6, D10
