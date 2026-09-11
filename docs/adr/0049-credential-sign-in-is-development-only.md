# ADR-0049: Credential sign-in is development-only; production is GitHub OIDC

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
`emailAndPassword` is enabled when `NODE_ENV !== 'production'` and disabled in production, where GitHub OIDC is the only door. `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` are optional locally and required in production.

## Context
ADR-0009 requires a fresh clone to boot with no secrets, and social providers need a client id and secret — so the two requirements can only both hold if the password path survives locally.

Consequence, named rather than discovered: a first-time GitHub sign-in in production lands on `FORBIDDEN` / "not a member of any organisation", because M4 has no invite flow and the seeded account is a password account. How the first admin gets a membership row in production is an M8 deploy concern.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
