# ADR-0068: Capabilities via better-auth's standalone `createAccessControl`, shared in contracts

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5 · **Implements:** ADR-0064

## Decision
One capability map in `@labelloop/contracts`, built on `createAccessControl` from `better-auth/plugins/access`, is read by the API (`requirePermission`, replacing `requireRole`) and by the console (replacing `isStaffRole`). **The trace LIST becomes `trace: [read]`** — staff only — closing M4's Deviation 32; annotators read traces only through their queue.

## Context
The utility is ~60 lines, pure and table-free (read in the installed 1.7.1 source) and already a dependency, so hand-rolling it buys nothing; the organization plugin that also ships one stays declined (ADR-0048). Sharing one map across the wire is the `names.ts` pattern: the UI can never promise what the server refuses.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decisions 9, 10)
