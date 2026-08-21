# ADR-0009: Containers-first; Railway now, AWS as documented escape hatch

**Status:** Accepted (amended 2026-08-21 by ADR-0013) · **Date:** 2026-08-19

## Decision
Everything ships as containers. Railway hosts the app today. Portability disciplines
are hard rules: (1) all config via env vars, zero platform-specific assumptions;
(2) only portable managed services (Postgres exists everywhere); (3) `docker compose
up` boots the ENTIRE stack locally from a fresh clone — same images production runs.
GPU inference (M7) deploys as a separate service on a GPU host regardless of platform.

## Amendment 2026-08-21 — Postgres is ours, not the platform's
Point (2) above ("only portable managed services (Postgres exists everywhere)") assumed a
*managed* Postgres at the deploy target. ADR-0013 supersedes that: Postgres ships as one
of our own containers in every environment, because the migrator/app role split and the
grant-enforced append-only audit log must hold identically everywhere, and a managed
add-on may withhold the privileges they require. The portability principle is unchanged —
it is strengthened. The deploy target is now subordinate to the container story rather
than the reverse.

## Context
Stakeholder requires credible portability to AWS without paying AWS complexity now.

## Consequences
- The AWS migration story is an ECS task definition away, and provable.
- Local dev, CI, and production share one container story; "works on my machine" dies.
