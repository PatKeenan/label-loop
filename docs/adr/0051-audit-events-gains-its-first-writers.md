# ADR-0051: M4 writes the first audit events

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
`api_key.issued`, `api_key.revoked`, `panel_version.created` and `judge_version.created` are written by application code, with `actor_type='user'`, the session's user id, and the `request_id` bound (ADR-0010). M8 still owns the viewer, retention and export.

## Context
`audit_events` has been append-only, grant-enforced and test-proven since M0 with zero writers; its own schema comment expected key issuance to be the first, and M1 issued keys from a seed script instead.

This is the first time the append-only grant is exercised by application code rather than by a test, and it makes M8's audit screen a read over real accumulated history rather than a demo over backfilled rows.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
