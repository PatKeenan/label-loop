# ADR-0048: better-auth’s organization plugin is not adopted

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
Organisation membership and roles stay in our own `org_members` table. better-auth's organization plugin is not installed, now or as part of M4's switcher work.

## Context
ADR-0014 deliberately placed `role` on `org_members` rather than on better-auth's `user`, because the tenancy model has org-scoped roles and guest experts invited into a specific org.

Adopting the plugin would relocate ADR-0014's decision into the auth library's own tables, making the roadmap's cross-org SME case a vendor question rather than ours.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
