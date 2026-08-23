# ADR-0003: Immutable configuration versions; scoped hashed keys with tier quotas

**Status:** Accepted (amended 2026-08-22 by ADR-0019) · **Date:** 2026-08-19

## Amendment 2026-08-22 — what is versioned is a panel and its judges
ADR-0019 replaces the classifier with a **panel** (`pnl_`/`pnv_`) containing **judges**
(`jud_`/`jdv_`). Read "classifier version" below as "judge version": every trace,
annotation, eval score and dataset row FKs to a `jdv_`, and keys are scoped to one panel.
The principle is unchanged — immutable versions are what make "it improved" provable —
only the object it applies to.

## Decision
Panel and judge configs (prompt, criteria, model, params) are immutable versioned rows;
edits create version n+1. Every trace, annotation, eval score, and dataset row references a
version. API keys are per-panel, SHA-256-hashed at rest, shown once, individually
rate-limited and metered, revocable by status flip. Subscription tiers set quotas:
max panels, max keys, monthly judgments.

## Context
"The judge improved" must be provable: agreement plotted per immutable version.
Key lifecycle and quotas are the concrete form of the auth + billing categories.

## Consequences
- Eval dashboards are version-pinned by construction; no ambiguous score timelines.
- Quota enforcement lives at the endpoint (429 with envelope), not in the UI.
- Trace storage grows with versions retained; retention policy handled in M8.
- Because each judge versions independently, agreement timelines are per judge — which is
  also what makes per-expert attribution possible in the contribution ledger.
