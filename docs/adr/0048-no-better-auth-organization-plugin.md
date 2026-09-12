# ADR-0048: better-auth’s organization plugin is not adopted

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
Organisation membership and roles stay in our own `org_members` table. better-auth's organization plugin is not installed, now or as part of M4's switcher work.

## Context
ADR-0014 deliberately placed `role` on `org_members` rather than on better-auth's `user`, because the tenancy model has org-scoped roles and guest experts invited into a specific org.

Adopting the plugin would relocate ADR-0014's decision into the auth library's own tables, making the roadmap's cross-org SME case a vendor question rather than ours.

## What the plugin actually does (checked 2026-09-11 against the installed 1.7.1)

Re-examined during phase 1, on the stakeholder's question of whether the library already
solves org switching and we were reinventing it. It does solve it — **differently, in the one
way ADR-0047 rejected** — so the two ADRs turn out to rest on the same finding:

1. **It owns the tenancy tables.** Its models are `Organization`, `Member`, `Invitation`,
   `Team`, `TeamMember`. `Member` is where role would live, which is ADR-0014's column.
2. **It stores the active org as a column on better-auth's `session` table**, adding
   `activeOrganizationId` to that model's fields, and `setActiveOrganization` is
   `updateSession(sessionToken, { activeOrganizationId })` — a WRITE to the session row.

Point 2 is precisely the design ADR-0047 turned down: a session is per-account and shared by
every tab, so switching org in one tab silently changes what another tab is looking at, while
that tab still displays the first org's chrome. The plugin is not wrong — it is a sound default
for products where one browser means one context — it is incompatible with the per-tab
independence the header buys. Our `session` table is correspondingly clean: no
`active_organization_id` column exists, and `auth.ts` registers no plugins.

**better-auth therefore answers exactly one question here: who is this.** Identity, password
hashing, cookies, session issuance and expiry, and (phase 2) the GitHub OIDC handshake.
Everything from "and which org may they see" onward is our `org_members` read.

## Consequence for the console

better-auth's CLIENT SDK still exposes `organization.*`, including `setActiveOrganization`.
Calling it from `apps/web` would be a no-op against our schema — the plugin is not registered
server-side and the column it writes does not exist — and it would fail quietly rather than
loudly. The switcher sets client state and the fetch wrapper sends `X-LabelLoop-Org`; it never
calls into better-auth for anything org-shaped.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
