# ADR-0069: Annotations are append-only, version-pinned, and attributed to the person

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5

## Decision
`annotations` is **append-only by Postgres grant** (`REVOKE UPDATE, DELETE` from the app role, proven by a test, as `audit_events`). Every row pins the `panel_version_id` it was made against (copied from the trace) and carries `annotator_id` referencing **`user` with ON DELETE RESTRICT**. A changed mind is a new row.

## Context
ADR-0061's audit trail — *which traces, annotated by whom, produced this judge* — and ADR-0003's version pinning both fail if an annotation can be rewritten or loses its version. Attribution attaches to the person, not the membership (PRODUCT.md §10's contribution ledger), so removing a member never orphans their work.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decisions 11, 12)
