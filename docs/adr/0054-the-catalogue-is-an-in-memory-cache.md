# ADR-0054: The model catalogue is an in-memory cache with a last-good snapshot

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The catalogue client lives in `src/llm/`, fetches models and per-model endpoints, caches in-process with a TTL, and serves the last good snapshot when a refresh fails. `fetch` is injected (ADR-0028) so tests run offline.

## Context
The picker needs catalogue data, and the failure mode — what the wizard does when the provider's models API is unreachable — deserved a decision rather than a default.

Rejected: a Postgres snapshot refreshed by a pg-boss job, which buys restart survival at the cost of a table, a migration and a job handler. A cold start with no network leaves the picker unpopulated, and the wizard must say so plainly rather than render an empty list. It must live in `src/llm/`: ADR-0016's architecture test fails the build on any provider hostname or outbound fetch outside it.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
