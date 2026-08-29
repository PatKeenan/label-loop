# ADR-0029: CD topology, and why the first deploy lands at M8

**Status:** Accepted · **Date:** 2026-08-29 · **Milestone:** M8 (decided during M1)

## Decision
Two decisions, one subject.

**Topology.** CI publishes SHA- and version-tagged **private** images to GHCR, and Railway
services source from them, so the digest CI booted and k6'd is the digest that runs
(ADR-0011). Four services mirroring compose: `postgres` (ours, per ADR-0013), a `migrate`
one-shot on the API image holding all three connection strings, `api` holding **only**
`DATABASE_URL` and gated on `/readyz`, and `web`. Private images require Railway Pro
(STACK_DECISIONS D10, amended 2026-08-29).

**Timing.** The first deploy moves out of M1 and becomes the **first deliverable of M8**.
Everything through M7 runs on `docker compose`.

## Context
BUILD_SPINE originally put CD at M1 ("from day one"). The stakeholder's sequencing is to reach
the product loop first — console, issued keys, data in the panel, error analysis, open and
axial coding, judge creation, the configuration surface, a fine-tune — before deploying.
Nothing in M2–M7 hard-blocks on a live URL, and it leads M8 rather than trailing it because
Stripe webhooks need a public endpoint and "public proof" needs something public.

## Consequences
- **The cost is named rather than discovered.** Deploying late concentrates every deploy
  surprise into one moment on the largest codebase the project will ever have: registry pull
  credentials, migration ordering without compose's `service_completed_successfully`, real
  cross-origin CORS and cookie `SameSite` across two domains, and the production config
  placeholders `config.ts` rejects. Spreading that out is what "deploy from day one" buys, and
  this trades it for a faster path to the product loop. ADR-0020 keeps real CORS partly under
  test in compose, which is what makes the trade tolerable rather than reckless.
- **Ordering falls out of an existing property**: Railway has no equivalent of compose's
  `depends_on: service_completed_successfully`, but `/readyz` checks migration currency and
  503s when behind, so the healthcheck holds the deploy until migrations land.
- **`preDeployCommand` on the api service is rejected**, though it is the Railway idiom: it
  would hand the API container the migrator credential and destroy the privilege split
  `server.ts` is explicit about.
- The console image is environment-specific (`VITE_API_URL` is a build arg) and is built
  twice. Runtime SPA config is the correct fix and is parked; ADR-0020 rules out making the
  origins match by reverse-proxying.
- **Open on pickup:** how Railway is told to use a new image tag, and re-verification of
  Railway's plan, pricing and config-as-code surface, which will be ~six milestones stale.

Full topology and phase detail, banked: `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` (the CD appendix, Decision 19).
BUILD_SPINE amended at M0, M1 and M8; SENIORITY_CHECKLIST updated.
