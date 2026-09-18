# ADR-0063: An account that belongs to no organisation creates one

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M4
**Amends:** CONSOLE_FLOW Q4 (the "member of nothing" screen offered no way forward) and the `/internal/me` contract

## Decision
A signed-in account that is a member of **no** organisation is shown **Create your organisation** — a name and a slug, one step — instead of a dead end. Submitting creates the org, makes the creator its **`admin`**, and writes an `org.created` audit event, in one transaction. The console then opens on that org's (empty) Home.

To make that possible:
- **`GET /internal/me` answers a member of nothing with data** — `200`, `memberships: []`, `active_org_id: null`, `role: null` — instead of `403 FORBIDDEN`.
- **`sessionAuth` is split.** `accountAuth()` establishes identity only; `sessionAuth()` is identity plus the active org, unchanged. Only two routes sit behind `accountAuth`: `GET /me` and `POST /orgs`. Every tenant route still refuses a member of nothing with `FORBIDDEN`.
- **`POST /internal/orgs` is for a member of nothing ONLY at M4.** A member of any org who calls it is refused `FORBIDDEN`; the console never offers it to them.

**This also settles what `FORBIDDEN` means in the console** (M4 plan, phase 8): *your role in this organisation does not allow this*, and nothing else. The error map's copy says so. A `FORBIDDEN` from any read re-asks `/me`, so a role changed or a membership removed under an open tab redraws the shell for who the account now is.

## Context
Found by the stakeholder while discussing what `FORBIDDEN` should mean (2026-09-18). The console had one code for two states — "member of no org" and "wrong role" — and one line of copy that was wrong for the first: *"Ask an owner of this organisation…"* when there was no organisation.

The deeper problem was not the copy. **M4's demo moment is "sign in with GitHub → create a panel", and a genuinely new GitHub account could not complete its first step.** It landed on *"This account isn't in an organisation"* with no action, because org creation was listed in CONSOLE_FLOW §3 as *named by PRODUCT.md, scheduled by nothing*. The flow only ever worked against the seeded `demo` org or a membership row inserted by hand. PRODUCT.md §7's own metric — signup → first judgment in under ten minutes — cannot be met from a dead end.

**Why data rather than a new error code.** A distinct code (`NOT_A_MEMBER`) was the alternative. It would have added a code to the closed taxonomy in `packages/contracts` for a state the console wants to render as a screen, not an error. Reading an empty membership list is simpler for the client and leaves `FORBIDDEN` with one meaning.

## Consequences
- **Unmetered org creation.** Any account that can sign in can create one organisation; in production that is any GitHub account (ADR-0049). There is no quota until M8's billing work. Recorded in `docs/PARKING_LOT.md`.
- **Slugs are global**, so "already taken" confirms an org with that slug exists — the same disclosure any taken-username check makes. A slug opens nothing; ids and membership are what authorise.
- **Creating a second organisation is NOT built**, and neither are invites or member management. Those belong with Organisation settings at M8 (ADR-0059), where "who may" has somewhere to be answered.
- **The creator is `admin`**, because they are the only person in the org and someone must be able to reach Organisation settings when it exists.
- **Two concurrent creates by the same account** could both pass the "member of nothing" check and produce two orgs. Accepted at M4: harmless, visible in the switcher, and closed properly when org limits arrive with M8.

Plan: `thoughts/shared/plans/complete/2026-09-11_m4-console-auth.md` (phase 8, Deviation 72) · Code: `apps/api/src/middleware/session.ts`, `apps/api/src/routes/internal/orgs.ts`, `apps/api/src/services/create-org.ts`, `apps/web/src/routes/create-org.tsx`
