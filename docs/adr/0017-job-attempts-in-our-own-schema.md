# ADR-0017: Job attempts are recorded in our own schema, not read from the queue's internals

**Status:** Accepted · **Date:** 2026-08-21

## Decision
Jobs record their attempts in a table we own. Nothing reads pg-boss's internal schema to
answer "how many times has this run?".

## Context
CONVENTIONS.md requires jobs to be idempotent and to record attempts in the database.
Satisfying that by querying the queue's internal tables would couple the application to
one queue's implementation details, which contradicts ADR-0006's premise that adding or
replacing queue technology stays an evidence-driven change if load testing proves the need.

## Consequences
- pg-boss remains swappable without touching application logic.
- A small amount of bookkeeping duplicates what the queue already tracks internally.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-J)
