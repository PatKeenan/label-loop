# ADR-0043: One alert rule, on `misconfigured`, visible in Grafana and paging nobody

**Status:** Accepted · **Date:** 2026-09-08 · **Milestone:** M3
**Applies:** ADR-0024

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`. Expand if the decision is challenged or its consequences grow.

## Decision

**M3 ships exactly one alert rule, on ADR-0024's `misconfigured` provider failure kind, and it
is visible in Grafana with no notification channel.** Stakeholder decision, 2026-09-08.

## Context

The condition was nominated in the decisions log on 2026-08-29, when `misconfigured` was
introduced: *"the strongest candidate for M3's single alert rule, being 100% actionable with no
false positives"*. It never self-heals, it takes every judge on every panel down at once, it is
already logged at `error`, and it carries its own `failure_kind` span attribute so a dashboard
cannot conflate "the provider is flaky" with "we did not pay the bill".

## Consequences

- **No credential, so ADR-0009's zero-secret boot is untouched.** A destination — PagerDuty,
  Slack, email, a webhook — would need one.
- **Nothing is deployed for it to page anyway**, which `docs/SENIORITY_CHECKLIST.md` already
  states, and which [ADR-0044](0044-observability-stays-compose-only.md) keeps true.
- The deliverable is a rule that visibly fires, demonstrated by driving the fake provider into
  the condition — not an on-call integration.
- **A real destination becomes a live question the day something is deployed to page about.**
  That is M8's territory, together with the deploy.

Plan: `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`
Provenance: `thoughts/shared/research/2026-09-08_m3-observability.md`
Related: ADR-0024, ADR-0044, ADR-0009
