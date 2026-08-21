# ADR-0006: Postgres everywhere until proven otherwise

**Status:** Accepted · **Date:** 2026-08-19

## Decision
Postgres is the only stateful service at launch: system of record (Drizzle,
forward-only migrations) AND the async queue (pg-boss). No Redis, no broker.
Fine-tune serving: vLLM (dynamic multi-LoRA). Training: Axolotl with YAML configs
committed to the repo; GPUs rented per job.

## Context
Every additional stateful service is an ops liability in a solo-built system. The k6
breaking-point work (M2/M8) exists precisely to discover real bottlenecks.

## Consequences
- If load tests prove queue or cache pressure, adding Redis becomes a documented,
  evidence-driven architecture change — a deliberate public artifact, not a default.
- One backup/restore story; docker-compose stays small.
