# ADR-0080: Review-set membership is a snapshot, append-only and timestamped

**Status:** Accepted · **Date:** 2026-09-20 · **Milestone:** M5 (phase 7)

## Decision
A set's picker (`manual`, `latest_n`, `earliest_n`, `random_n`) resolves ONCE and writes membership
rows; it is not a query that re-evaluates. Membership is a join of two ids — the trace is never
copied — is unique per `(set, trace)`, and is append-only by Postgres grant with `added_at` on
every row. A set grows only by an explicit TOP-UP, which runs a picker again and appends.

## Context
What a past annotation pass covered must be reconstructible (ADR-0003), which a re-evaluating
query destroys. Append-only membership is what makes top-up safe: rows only ever arrive, so "what
the set held when this annotation happened" stays a query rather than a lost fact. It is the same
treatment `audit_events` and `annotations` have, and the versioned join table CONVENTIONS asks for
in place of a flag on the row.

Plan: `thoughts/shared/plans/approved/2026-09-20_review-sets.md` (decisions 1, 2)
