# ADR-0013: Postgres ships as our own container in every environment

**Status:** Accepted · **Date:** 2026-08-21 · **Amends:** ADR-0009

## Decision
Postgres runs as one of our containers everywhere, including production, rather than as a
managed add-on. The deploy target is chosen to fit that constraint, not the other way
around: if a host cannot run our Postgres container with a persistent volume, the host
changes, not the code.

## Context
The migrator/app role split requires `CREATE ROLE` privileges a managed add-on may
withhold, and the append-only audit guarantee is worth little if it holds locally but not
in production. Owning the container makes the roles, grants, and enforcement identical in
every environment, with no environment-specific branches — ADR-0009's stated principle
taken literally rather than its hosting footnote.

## Consequences
- Backups, restore testing, and durability become ours rather than an add-on's. Not M0
  work (M0's volume is throwaway); it belongs to M1's CD planning, where a live URL first
  holds real data.
- Railway remains the intended host but is explicitly replaceable.
- Reversible: the app connects by URL, so a managed Postgres stays available later.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-Q)
