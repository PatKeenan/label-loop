# ADR-0009: Containers-first; Railway now, AWS as documented escape hatch

**Status:** Accepted · **Date:** 2026-08-19

## Decision
Everything ships as containers. Railway hosts the app today. Portability disciplines
are hard rules: (1) all config via env vars, zero platform-specific assumptions;
(2) only portable managed services (Postgres exists everywhere); (3) `docker compose
up` boots the ENTIRE stack locally from a fresh clone — same images production runs.
GPU inference (M7) deploys as a separate service on a GPU host regardless of platform.

## Context
Stakeholder requires credible portability to AWS without paying AWS complexity now.

## Consequences
- The AWS migration story is an ECS task definition away, and provable.
- Local dev, CI, and production share one container story; "works on my machine" dies.
