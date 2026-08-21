# ADR-0014: Roles are org-scoped, on `org_members` rather than the user record

**Status:** Accepted · **Date:** 2026-08-21

## Decision
The `role` column lives on an `org_members` table (`org_id`, `user_id`, `role`), created
in the first migration and unenforced until M4. It does not live on better-auth's `user`
table.

## Context
A role on `user` encodes one global role per person, which the tenancy model contradicts:
PRODUCT.md 5.1 has org-scoped roles and guest experts invited into a *specific* org, and
the post-V1 roadmap has SMEs working across several orgs. Placing it on `user` now and
moving it at M4 would perform exactly the data migration that shipping the column early
was meant to avoid.

## Consequences
- Multi-org membership is representable from day one; M4 adds enforcement, not schema.
- `orgs` and `org_members` both exist before any UI does.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-P)
