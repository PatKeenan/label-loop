# ADR-0052: The judge wizard holds its draft in client state

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The panel/judge wizard keeps its in-progress configuration in the browser until submit, which writes `pnl_`, `pnv_`, `jud_`, `jdv_` and the join in one transaction and then activates via `panels.current_version_id`.

## Context
Migration 0005 revokes `UPDATE` and `DELETE` from the app role on `panel_versions` and `judge_versions`, so a mutable server-side draft row on those tables is not representable — immutability is a Postgres grant here, not a convention.

A separate mutable draft table would be a way around this and is deliberately not taken at M4; it would need its own ADR, because it reintroduces the editable configuration ADR-0003 exists to prevent.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
