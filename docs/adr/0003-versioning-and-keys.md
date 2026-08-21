# ADR-0003: Immutable classifier versions; scoped hashed keys with tier quotas

**Status:** Accepted · **Date:** 2026-08-19

## Decision
Classifier configs (prompt, labels, model, params) are immutable versioned rows; edits
create version n+1. Every trace, annotation, eval score, and dataset row references a
version. API keys are per-classifier, SHA-256-hashed at rest, shown once, individually
rate-limited and metered, revocable by status flip. Subscription tiers set quotas:
max classifiers, max keys, monthly classifications.

## Context
"The classifier improved" must be provable: scores plotted per immutable version.
Key lifecycle and quotas are the concrete form of the auth + billing categories.

## Consequences
- Eval dashboards are version-pinned by construction; no ambiguous score timelines.
- Quota enforcement lives at the endpoint (429 with envelope), not in the UI.
- Trace storage grows with versions retained; retention policy handled in M8.
