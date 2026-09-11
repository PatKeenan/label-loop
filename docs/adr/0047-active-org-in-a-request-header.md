# ADR-0047: The active org travels in a request header

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The console's active organisation is sent as an `X-LabelLoop-Org` header and validated against `org_members` in `sessionAuth`, falling back to the first membership when absent. Internal route handlers stay org-implicit; the org becomes explicit once, at the boundary.

## Context
ADR-0014 made roles org-scoped and multi-org representable from day one, and M4 ships the switcher that makes a second membership reachable — so a request has to say which org it means without every route and every client call being rewritten.

Rejected: a path segment (`/internal/orgs/:id/...`), which rewrites every route and every client call; and a server-side "active org" on the session, under which a second browser tab in another org silently changes what the first tab is looking at.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
