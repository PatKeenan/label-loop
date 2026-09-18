---
date: 2026-09-18T21:00:00Z
author: claude-code
status: approved
approved_at: 2026-09-18T21:30:00Z
approver: Pat Keenan
milestone: M5
topic: m5-members-annotation
related_adrs: [0003, 0014, 0019, 0036, 0037, 0047, 0048, 0051, 0055, 0057, 0059, 0060, 0061, 0063, 0064]
research: thoughts/shared/research/2026-09-18_m5-members-annotation.md
spawned_adrs: [0065, 0066, 0067, 0068, 0069, 0070, 0071, 0072]
---

# M5 — members, capabilities, and the annotation loop

## Goal
Let a real person annotate real traces. An org admin puts people into the org with a role; a
role grants **capabilities**, and the surface is a preference (ADR-0064), so a developer can
annotate while an annotator still cannot touch keys or panels; and an annotator — or any staff
member who opts in — works a per-panel queue of collected traces, one at a time, recording
whether the agent's output was **acceptable** and, when it was not, **why**. Every annotation
row carries `annotator_id` and the immutable panel version it was made against (CLAUDE.md hard
rule, ADR-0003), because M6 authors judges from these rows and measures them against them.

**Milestone: M5 — Annotation loop** (docs/BUILD_SPINE.md). Member management is not in M5's
text; it is a prerequisite ADR-0064 established (M5 cannot put an annotator in an org without
it), and is recorded here rather than as scope creep. The stakeholder accepted all eight of the
research's recommendations on 2026-09-18; they are this plan's decisions 1–8.

Each phase is one branch and one PR (`feat/m5-p1-capabilities`, …), per CLAUDE.md "Branching".

---

## Phase 1 — Capabilities replace role lists (ADR-0064)

### Changes
- `packages/contracts/src/capabilities.ts` (new) — the capability map, built on better-auth's
  standalone `createAccessControl` (`better-auth/plugins/access`; pure, no tables — read in the
  installed 1.7.1 source). Resources and actions:
  `panel: [read, create]`, `key: [read, issue, revoke]`, `model: [read]`, `judge: [read]`,
  `trace: [read]`, `annotation: [create]`, `member: [read, manage]`.
  Roles: **admin** — everything; **engineer** — everything except `member: [manage]`;
  **annotator** — `annotation: [create]` only; **guest_expert** — **nothing** until M8 (open
  question 3, resolved: its time-boxing, panel scoping and PII masking are M8's, and annotation
  access without them would hand an outsider every trace in the org). Exported: `can(role, request) → boolean`, `ROLES`.
- `packages/contracts/package.json` — `better-auth` as a dependency (already in the workspace
  at the same version; the contracts package imports only the `/plugins/access` entry).
- `apps/api/src/middleware/require-permission.ts` (new) — `requirePermission({ key: ['issue'] })`,
  same single non-enumerating FORBIDDEN message as `requireRole`, same active-org resolution.
- Every `requireRole(...)` call site → `requirePermission(...)`: `panels.ts`, `keys.ts`,
  `models.ts`, `judges.ts`, `traces.ts` (detail). `require-role.ts` is deleted.
- `apps/api/src/routes/internal/traces.ts` — **the LIST route gains `trace: [read]`**, closing
  Deviation 32: an annotator reads traces through their queue (phase 4), never the list.
- `apps/web/src/components/shell/context.ts` — `isStaffRole` → `can(role, …)` from the shared
  map; every UI gate reads a capability, not a role name.
- Tests: `apps/api/src/middleware/require-permission.test.ts` — a matrix of role × route
  (every role, every guarded route, expected 2xx/403), plus the existing guard tests re-expressed.
  `packages/contracts/src/capabilities.test.ts` — the map itself (engineer cannot manage members;
  annotator cannot read keys; every role in the enum has an entry).

### Steps
- [x] Capability map in contracts, with its test
- [x] `requirePermission`, all call sites moved, `require-role.ts` deleted
- [x] Trace list guarded by `trace: [read]` (Deviation 32 closed)
- [x] Console reads capabilities; `isStaffRole` removed
- [x] Role × route matrix test green

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build` — 841 pass;
      the 2 failures are `relations.test.ts`'s seed-state ones (M4 Deviation 64)

### Manual verification
- [x] Engineer and admin see exactly what they saw before; an annotator still sees
      "Nothing to review yet" and gets 403 on keys, panels and the trace list by direct call
      — verified by the stakeholder, 2026-09-18

---

## Phase 2 — Members: invite by email, claimed on sign-in

### Changes
- `packages/db/migrations/0012_org_invitations.sql` + `schema/org-invitations.ts` —
  `org_invitations`: `id (inv_)`, `org_id`, `email` (stored lowercased), `role`,
  `invited_by` (→ user, RESTRICT), `created_at`, `expires_at` (14 days), `accepted_at`,
  `accepted_by`, `revoked_at`. Partial unique index: one PENDING invitation per `(org_id, email)`.
  `inv_` added to `ID_PREFIXES`.
- `apps/api/src/services/members.ts` (new) — invite, revoke invitation, change role, remove
  member, **claim**; every write in one transaction with its audit event (`invitation.created`,
  `invitation.revoked`, `invitation.accepted`, `member.role_changed`, `member.removed`).
  **Last-admin guard**: an org must keep at least one admin — demoting or removing the last is a
  422 on the field.
- **Claim on sign-in**: `GET /internal/me` (behind `accountAuth`, ADR-0063) claims every pending,
  unexpired invitation whose email matches the account's **verified** email, before answering.
  `/me` is the console's bootstrap read, so the first page load after signing in is the claim.
  An unverified email claims nothing.
- `apps/api/src/routes/internal/members.ts` (new) — `GET /internal/members` (members + pending
  invitations, `member: [read]`), `POST /internal/invitations`, `DELETE /internal/invitations/:id`,
  `PATCH /internal/members/:userId`, `DELETE /internal/members/:userId` (all `member: [manage]`).
  Another org's invitation or member is NOT_FOUND (ADR-0057).
- Console: **Organisation settings stops being an inert M8 item** — the account-menu entry opens
  `/settings/members` (admin-only, ADR-0059). A Members screen: invite (email + role), the member
  list with a role select, remove with confirmation, pending invitations with revoke. Email and
  role validation from shared rules in `@labelloop/contracts`.
- Tests: claim (verified match joins with the invited role; unverified does not; expired does
  not; revoked does not; a second claim is a no-op); last-admin guard; NOT_FOUND across orgs;
  every write leaves its audit row.

### Steps
- [x] Migration + schema + `inv_` prefix
- [x] Members service with the last-admin guard and audit events
- [x] Claim in `/me`, verified-email only
- [x] Members routes with capability guards
- [x] Members screen under Organisation settings
- [x] Tests above, including a mutation check on the verified-email condition

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build` — 880 pass;
      the 2 failures are `relations.test.ts`'s seed-state ones (M4 Deviation 64)

### Manual verification
- [ ] As admin, invite a second GitHub account as **annotator**; sign in as it → it lands in the
      org with that role, no SQL involved
- [ ] Change that member to **engineer** and back; remove them; the last admin cannot be demoted

---

## Phase 3 — `annotator-session`, redrawn · HUMAN REVIEW GATE (Phase A)

Phase A resumes for ONE screen (decision 6; ADR-0055 is the precedent). The harvest's r4 was
drawn for agree/correct against a classifier; r5 is drawn for what M5 actually does.

### Changes
- `mockups/annotator-session.html` (r5) — plain HTML on `tokens.css`, `data-surface="annotator"`
  (light + comfortable). Keeps r4's decisions that still apply: IN/OUT pair at equal weight
  (artifact = OUT, context = IN, per ADR-0036/0037), equal-weight verdict buttons, required
  ≤280-char note on "not acceptable", free skip, keyboard-first (Y / N / S, Enter), **no
  confidence, model, cost or trace id** (decision 8), minimal chrome. New: the binary is
  *acceptable / not acceptable* (no judge verdict to agree with — decision 2), a session progress
  line, and the empty and locked states (queue drained; panel below 50).
- `mockups/BRIEF.md` — the screen's status and review outcome.

### Steps
- [ ] r5 drawn, with its decisions and open questions in the header comment, as the harvest style
- [ ] **Reviewed and approved by the stakeholder** before phase 5 starts

### Automated verification
- [ ] `bun run lint` (the mockup is outside Biome; this proves nothing about it — Deviation 33 of
      the M4 plan — the review is the gate)

### Manual verification
- [ ] Stakeholder review of r5 in a browser; revisions recorded in the header's REVISION line

---

## Phase 4 — Annotations: the append-only record and the queue

### Changes
- `packages/db/migrations/0013_annotations.sql` + `schema/annotations.ts` — `annotations`:
  `id (ann_)`, `org_id`, `trace_id` (→ traces), `panel_id`, `panel_version_id` (copied from the
  trace at write time — pinned, ADR-0003), `annotator_id` (→ user, **RESTRICT**: contribution
  attaches to the person, PRODUCT.md §10), `outcome` enum (`acceptable | not_acceptable |
  skipped`), `note` (CHECK ≤280 chars; required when `not_acceptable`; null when `skipped`),
  `sampler` (text, `random` at M5 — recorded so M6's samplers slot in), `created_at`.
  **Append-only by grant**: `REVOKE UPDATE, DELETE ON annotations FROM labelloop_app`, proven by a
  test like `audit_events`'. A changed mind is a new row. Many rows per trace are permitted.
  `ann_` added to `ID_PREFIXES`.
- `apps/api/src/services/annotation-queue.ts` (new) — **next item** for (panel, annotator):
  a random trace of that panel with **no non-skip annotation from anyone** and **not skipped by
  this annotator** (decision 7: one person per trace at M5; a skip frees it for someone else).
  Gated at `ANNOTATION_FLOOR` (50, moved into `@labelloop/contracts` so API and console share it).
- `apps/api/src/routes/internal/review.ts` (new), all `annotation: [create]`:
  - `GET /internal/review/panels` — panels in the active org with their trace count, whether the
    gate is open, and how many items remain for this annotator. (Annotators cannot read
    `GET /internal/panels`; this is the minimum they need.)
  - `GET /internal/review/panels/:slug/next` — one item: `{ item_id, artifact, context }` and
    progress. **No verdicts, scores, confidence, model, cost, key or trace id** in the payload —
    the annotator surface cannot leak what the response never carries (decision 8). Locked below
    the floor; empty when drained.
  - `POST /internal/review/annotations` — `{ item_id, outcome, note? }`; writes the row with the
    pinned version; audit event `annotation.created` (ids only, never the note).
- Tests: the payload has none of the withheld fields (asserted by key); the queue never serves a
  trace someone has annotated; a skipper is not re-served what they skipped; the floor gate; note
  rules; append-only grant; `annotator_id` and `panel_version_id` are set on every row; another
  org's trace is NOT_FOUND.

### Steps
- [ ] Migration + schema + grant + `ann_` prefix
- [ ] Queue service
- [ ] Review routes and payload shape
- [ ] Tests above, with a mutation check on "no non-skip annotation from anyone"

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] `curl` as an annotator session: `next` on the 51-trace panel returns an item with only
      artifact and context; three annotations (acceptable, not acceptable + note, skip) are stored
      with the right annotator and panel version, and a direct UPDATE on the table is refused

---

## Phase 5 — The annotator surface, built from r5

### Changes
- `apps/web/src/router.tsx` — a second pathless layout, `reviewRoute`, **outside** the console
  shell (its own frame, `data-surface="annotator"`), same `beforeLoad` session redirect:
  `/review` (the panel list) and `/review/$panelSlug` (the session).
- `apps/web/src/routes/review.tsx`, `review-session.tsx` (new) — rebuilt clean from the approved
  r5 (Phase C: never ported). Keyboard handling, the note's required state and live cap, skip,
  progress, the locked and drained states.
- **Landing (decision 3):** an annotator's `/` goes to `/review` — "Nothing to review yet" becomes
  the real surface. Staff keep landing in the console.
- **Staff opt-in:** the panel sidebar's inert **Annotation · M5** item becomes **Review traces**,
  live once the gate is open (padlocked with "opens at 50 traces" below it), opening
  `/review/$panelSlug`. The Overview's "ready to annotate" gate card links there too.
- Portalled overlays on this surface use `useSurface('annotator')` (Deviation 53 of M4).

### Steps
- [ ] Review layout and routes, outside the console shell
- [ ] Session screen from r5, keyboard-first
- [ ] Annotator landing → `/review`
- [ ] Staff "Review traces" section + gate-card link
- [ ] `bun test apps/web` covers the pure parts (keyboard map, note rules)

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`

### Manual verification
- [ ] **The M5 demo moment**: as an annotator invited in phase 2, annotate 20 real traces in under
      5 minutes, keyboard only
- [ ] As an engineer, open **Review traces** from the sidebar and annotate; the console is one
      click away; the annotator surface never shows confidence, model, cost or ids

---

## Phase 6 — Seeing the annotations (staff)

### Changes
- Trace drawer / trace page (M4 Deviation 75) — an **Annotations** block after Response: who,
  when, outcome, note. Staff-only (it is behind `trace: [read]`).
- Traces table — a compact annotated mark in the Verdict column's row; the Overview gate card
  shows annotations collected so far against the 100 target.

### Steps
- [ ] Annotations in the trace detail read and the drawer/page body (one component, both places)
- [ ] Annotated mark in the table; annotation count on the Overview

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`

### Manual verification
- [ ] A trace annotated in phase 5 shows its annotation, annotator and note in the drawer and on
      its page; the Overview's count matches

---

## Decisions made
Each becomes an ADR stub at `/approve_plan`. Next free number after ADR-0064 is **0065**.

1. **Membership by pending invitation, claimed on first sign-in against a VERIFIED email; no
   email is sent** (stakeholder, 2026-09-18) — over direct add of existing accounts only (fails
   for anyone who has never signed in) and over invitation emails (needs an email provider, a
   stakeholder-owned stack decision). Emails can be layered on later without changing the table.
2. **The first annotation is a binary *acceptable / not acceptable* plus a note, required when
   not acceptable** — over agree/correct, which needs a judge verdict a collecting panel does not
   have (ADR-0060/0061); the binary is what M6 aligns judges against and the note is what axial
   coding clusters.
3. **Annotators land on their own surface; staff opt in per panel via "Review traces"** — the
   ADR-0064 split made concrete: landing stays role-derived, exclusivity is dropped.
4. **The queue is per panel** — the gate, the taxonomy and the judges are all per panel.
5. **Random over un-annotated traces at M5, with the sampler recorded on each row** — the other
   samplers need judges (low-confidence, disagreement) or gold labels (honeypots).
6. **Phase A resumes for `annotator-session` only** (ADR-0055 precedent) — r4 predates judgeless
   panels; a reviewed screen is cheaper than rebuilding a wrong one.
7. **Many annotations per trace are permitted; M5 serves each trace to one person** — M6/M7 need
   overlap; M5's "Not now" excludes consensus. A skip frees the item for others.
8. **No confidence, model, cost, verdict, key or trace id reaches the annotator surface —
   enforced in the API payload, not only the UI** (harvest blocker 2, adopted) — automation bias
   is asymmetric and would inflate the agreement M6 exists to measure honestly.
9. **Capabilities via better-auth's standalone `createAccessControl`, in `@labelloop/contracts`**
   — over hand-rolled maps (the utility is ~60 lines, pure, already a dependency) and over the
   organization plugin (ADR-0048). Shared by API and console, as `names.ts` is.
10. **The trace LIST becomes `trace: [read]` (staff)** — closing M4's Deviation 32; annotators
    read traces only through their queue.
11. **Annotations are append-only by Postgres grant** — `audit_events`' pattern; a changed mind is
    a new row, so "who said what, when" is never rewritten.
12. **`annotator_id` references `user` with RESTRICT** — contribution attaches to the person, not
    the membership (PRODUCT.md §10), so removing a member never orphans their work.
13. **Organisation settings becomes live at M5 with Members as its first screen** — amending
    ADR-0059's "absent until M8".
14. **An org must always keep one admin** — enforced in the service, reported as a field error.
15. **Invitations expire after 14 days** (open question 1, resolved) — long enough for someone to
    get round to signing in, short enough that a forgotten invitation does not grant access months
    later. Revocable before then.
16. **Annotators see a progress line, not a history list, at M5** (open question 2, resolved) — a
    list of past answers invites second-guessing and re-annotation, and a changed mind is a new
    row anyway.
17. **`guest_expert` grants no capability until M8** (open question 3, resolved) — PRODUCT.md 5.1's
    guest access is time-boxed, panel-scoped and PII-masked; without those, it is an outsider with
    an org's traces.

## Explicitly NOT doing
- **Invitation emails** — no email provider (stack decision); the admin tells the person to sign in.
- **Agree/correct against a judge verdict**, the post-submit reveal (harvest Q9), blind mode (Q1).
- **Low-confidence, judge-disagreement and honeypot samplers**; annotation rounds (harvest
  blocker 3) — M6.
- **Multi-annotator consensus, inter-annotator stats, gamification, streaks** — M5 "Not now".
- **Guest-expert time-boxing, panel scoping and PII masking** — M8 (PRODUCT.md 5.1).
- **Creating a second organisation** — ADR-0063 keeps that for member-of-nothing only.
- **Labeling mode against a taxonomy** — the taxonomy is M6's output.
- **The dogfood tenant, the showcase tenant, and deleting the seeded placeholder judge** — M5
  items, but separate work from this plan.
- **Roles as a set per membership** — ADR-0064 made it unnecessary.

## Open questions for the human
All three were resolved by the stakeholder on 2026-09-18, accepting the recommendations; they
are decisions 15–17.

## Deviations
Recorded as they happen; decision provenance, not a changelog.

### Phase 1
1. **Guards are per route, each naming its own action, instead of a file-level `.use`.** The
   plan's `requirePermission({ key: ['issue'] })` implies it: a file-level guard can only ask for
   one action, so `GET /keys` would have needed `issue`. What a file-level `.use` gave for free —
   a new route in the file is guarded by construction — is kept by the matrix test instead: it
   compares Hono's own registered-route list against the matrix, so a route added without a row
   (and therefore without a proven guard) fails the suite. Mutation-checked: removing the trace
   list's guard fails exactly the annotator and guest-expert rows.
2. **`ROLES` lives in `@labelloop/contracts`, and the `org_role` Postgres enum is built from it.**
   The capability map is `satisfies Record<OrgRole, …>`, so the plan's "every role in the enum
   has an entry" is a compile error rather than only a test. Same values, same order:
   `drizzle-kit generate` reports no schema change, so no migration.
3. **`POST /judges/validate-pin` asks for `judge: [read]`.** It is a check made while authoring a
   judge, and the map has no `judge: [create]`; every role with `judge: [read]` also has
   `panel: [create]`, so nothing is admitted that the old guard refused. Revisit if M6's judge
   authoring adds a write action.
4. **The matrix asserts "admitted" as *not refused by the guard*, not as 2xx.** With no database
   an admitted request reaches a handler that may answer 422 or 500; the guard's own decision is
   403-or-not, and that is what is asserted, in both directions, with the `FORBIDDEN` code.
5. **`session.test.ts`'s "the org scopes the ROWS" relied on Deviation 32** — it listed traces as
   the annotator in the second org and expected 200. Re-expressed as the stronger claim: the same
   account reads the list as admin in the first org (200) and is refused it as annotator in the
   second (403), which a guard resolving against the first membership would fail.
6. **The organisation-settings menu item is gated by `member: [manage]`** (was `role === 'admin'`);
   it stays inert until phase 2.
7. **`.claude/launch.json` gains an `api` configuration** (`bun run --cwd apps/api dev`), so the
   API runs from source beside the console in the preview pane, as CLAUDE.md prescribes.

### Phase 2
8. **`guest_expert` cannot be invited or granted** (`GRANTABLE_ROLES` in `@labelloop/contracts`
   `members.ts`). The plan said "email + role" without narrowing; ADR-0072 makes a guest-expert
   member a person who can do nothing, so offering the role would be offering a dead end. An
   existing guest-expert member (only possible by SQL) shows their role read-only.
9. **An EXPIRED open invitation is closed (stamped `revoked_at`) when the same email is invited
   again.** The one-open-invitation-per-email index cannot include expiry — `now()` is not
   immutable, so it cannot sit in a partial index's predicate — and without this, an expired
   invitation would block re-inviting that person forever.
10. **Audit events carry ids and roles, never the email.** The audit log cannot be edited, and an
    address is what M8's erasure must be able to scrub; the invitation row holds the email and
    the event points at it by `inv_` id.
11. **The last-admin guard takes a row lock on the org's admins.** A check-then-write without it
    lets two admins demote each other at the same moment and leave nobody. Tested at the service
    level: over HTTP the second request is usually refused earlier, as a non-admin (403), so the
    lock is only proven where both writes are already past the guard.
12. **`GET /internal/members` is `member: [read]`** — engineers may read it (the plan gave them the
    capability) — but the SCREEN is admin-only, per ADR-0070; the account-menu item is hidden,
    not disabled, for anyone who cannot manage members.
13. **The member write routes use Hono's built-in `validator('json')`**, not a hand-parse, so the
    body's type reaches the console over RPC (a hand-parsed PATCH body is invisible to
    `hc<AppType>` and did not typecheck). Its own 400 for a body that is not JSON reaches the
    central handler as INTERNAL, so a small `wellFormedJson` middleware runs first and makes it
    the usual 422 — tested.
14. **CORS now allows PATCH and DELETE** (it allowed GET and POST only), which a role change and a
    removal need from the browser. No test can catch this — `app.request()` sends no preflight.
15. **Every local seeded account is UNVERIFIED** (`email_verified = false`; they were made with
    email and password). So the manual check must use GitHub accounts, as the plan says — an
    invitation to `annotator@labelloop.test` will correctly never be claimed.
