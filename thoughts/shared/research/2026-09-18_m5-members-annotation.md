---
date: 2026-09-18T20:30:00Z
author: claude-code
status: draft
milestone: M5
topic: m5-members-annotation
related_adrs: [0003, 0014, 0019, 0036, 0037, 0047, 0048, 0055, 0059, 0060, 0061, 0063, 0064]
---

# M5 — members, capabilities, and the annotation loop

## Problem summary
M5 must let a person annotate real traces, and three things stand in the way. **Nobody can be
put into an org** except by SQL: member management was "named by PRODUCT.md, scheduled by
nothing". **The guard is role-lists** (`requireRole('admin', 'engineer')`), but ADR-0064 now
says a role grants CAPABILITIES and the surface is a preference — a developer may annotate.
And **there is no annotation schema or surface at all**; the only design, the harvest's
`annotator-session` r4, assumes a judge verdict to agree/correct, while ADR-0060/0061 made
every new panel start with NO judges — so the first annotation a panel receives is **open
coding**, not agree/correct.

## Relevant files/modules
- `packages/db/src/schema/org-members.ts` — the membership row (PK `(org_id, user_id)`, one `role` enum); stays, per ADR-0014/0064.
- `packages/db/src/schema/columns.ts` — `orgRole` enum (`admin|engineer|annotator|guest_expert`).
- `packages/db/src/schema/auth.ts` — `user.email_verified`; GitHub sign-ins arrive verified (checked: the stakeholder's row is `t`).
- `packages/db/src/schema/traces.ts`, `trace-verdicts.ts` — what an annotation points at; a trace pins `panel_version_id`, a verdict pins `judge_version_id`.
- `apps/api/src/middleware/require-role.ts` — the guard ADR-0064 replaces; 6 call sites (panels, keys, models, judges, trace detail).
- `apps/api/src/middleware/session.ts` — `accountAuth` / `sessionAuth` / `resolveActiveOrg` (ADR-0063); invitations claim here.
- `apps/api/src/routes/internal/orgs.ts`, `services/create-org.ts` — the pattern for a membership write: one transaction + audit event.
- `apps/api/src/repositories/audit-events.ts` — `member.added`, `invitation.*`, `annotation.*` belong here (append-only, ADR-0051).
- `apps/web/src/routes/root.tsx` — non-staff today get a "Nothing to review yet" statement: the annotator's future landing.
- `apps/web/src/components/shell/context.ts` — `isStaffRole` allow-list; becomes a capability read.
- `apps/web/src/components/shell/gate.tsx` — `ANNOTATION_FLOOR = 50`, `ANNOTATION_TARGET = 100`.
- `packages/contracts/src/names.ts` — the precedent for rules shared by API and console.
- `node_modules/…/better-auth@1.7.1/dist/plugins/access/access.mjs` — `createAccessControl` read in source: ~60 lines, pure, `role.authorize(req) → {success, error}`, no tables.
- `thoughts/shared/research/2026-08-20_phase-a-design-harvest.md` — `annotator-session` r4 decisions 1–12 and open Q1–Q9; blockers 1–6.

## Existing patterns and constraints
- **CLAUDE.md hard rule:** every annotation schema carries `annotator_id` and immutable dataset-version links from day one.
- **ADR-0003:** every annotation references a version — a trace pins its `pnv_`; any judge verdict annotated pins its `jdv_`. Annotation rows are append-only in spirit (a re-annotation is a new row), like the version tables (migration 0005 revokes UPDATE/DELETE there).
- **ADR-0014 / ADR-0048 / ADR-0047:** membership and role stay on OUR `org_members`; better-auth's organization plugin is declined (it owns tenancy tables and writes an active org onto the session). Re-verified today against 1.7.1: its invitations, `addMember`, multi-role (comma-separated string) and dynamic roles all live in its own `member`/`invitation` tables — adopting any of it re-opens both ADRs.
- **ADR-0064:** capabilities per role; surface is a preference; engineer/admin may annotate; annotator stays keyless. No schema change required.
- **ADR-0063:** `accountAuth` routes serve a member of nothing; keep that list short. A pending invitation is exactly the thing such an account should be able to accept.
- **ADR-0057:** another org's object is NOT_FOUND, never FORBIDDEN — invitations and annotations included.
- **ADR-0059:** members management would live under Organisation settings, admin-only. A Members screen is its first real content, which makes Organisation settings non-empty at M5 rather than M8.
- **ADR-0061:** annotation unlocks at 50 traces; judges are authored FROM annotations (M6). The chain "which traces, annotated by whom" is the point.
- **ADR-0036/0037:** a trace is a pair — `artifact` (what the agent produced) + `context` (incl. a deciding agent's own decision). The annotator judges the pair; the harvest's r3 IN/OUT framing matches the trace drawer's Request/Response just shipped.
- **Harvest `annotator-session` r4:** no confidence shown to annotators (blocker 2); judge verdict withheld until after submit; correction requires a ≤280-char note; skip is free and routed away; keyboard-first (Y/N/S); no model/cost/trace id on the surface; light + comfortable `data-surface="annotator"`.
- **CONVENTIONS "Keys & auth":** roles enforced in the API, never only in the UI.
- **No email provider** exists in `docs/STACK_DECISIONS.md`; adding one is a stakeholder-owned stack decision.
- **Phase A:** `annotator-session` is PAUSED (ADR-0055). Its r4 mockup exists as harvest text, not as an approved screen; ADR-0055's precedent is "resume for the frame plus one room".
- **BUILD_SPINE M5 text is stale in one respect:** it says "agree/correct", which presumes judges; after ADR-0060/0061 the first pass on any new panel has none.

## Open questions for the human
1. **How does someone get INTO an org?** (a) Admin adds an existing account by email — only works for people who have already signed in once. (b) **Pending invitation by email, claimed automatically on first sign-in** when the verified email matches (no email is SENT; the admin tells them to sign in) — works for people who have never visited, needs a small `org_invitations` table, no stack decision. (c) Real invitation emails — needs an email provider (stack decision). Recommend (b), with (c) layered on later.
2. **What is the first annotation, on a panel with no judges?** Open coding per PRODUCT.md 5.5 — the trace pair and a note — but does the human ALSO record a binary *acceptable / not acceptable* verdict (Husain-style pass/fail + critique)? Recommend yes: the binary is what M6's judge alignment is measured against, and the note is what axial coding clusters. Agree/correct against a judge's verdict comes later, when judges exist.
3. **Where do annotators land, and how does staff opt in?** Recommend: annotators land on their own surface (the "Nothing to review yet" slot becomes it); staff get a **"Review traces"** entry per panel (a section in the panel sidebar, currently the inert "Annotation · M5" item) that opens the same surface.
4. **Queue scope:** per panel, or across all panels an annotator can see? Recommend per panel (the gate, the taxonomy and the judges are per panel).
5. **Sampling at M5:** random only, or random + "not yet annotated" ordering? Low-confidence and judge-disagreement samplers need judges (M6); honeypots need gold labels. Recommend random over un-annotated traces only, with the sampler recorded on each item so the others slot in.
6. **Does Phase A resume for `annotator-session`** (a reviewed mockup before code, as ADR-0055 did for the console frame)? Its r4 was never reviewed against the collecting-panel reality. Recommend yes, one screen, reviewed before the surface is built.
7. **One annotator per trace, or overlap?** M5's "Not now" list excludes multi-annotator consensus. Recommend: schema permits many annotations per trace (it must, for M6/M7), the queue serves each trace to one person at M5.
8. **Harvest blockers 1–6 that M5 touches:** blocker 2 (confidence withheld — recommend ADOPT, it is already r4's rule and is an eval-integrity constraint), blocker 3 (the "annotation round" object — recommend DEFER to M6, where rounds are measured), gamification (M5 "Not now").

## Recommended approach
Three slices, each shippable, in this order:
1. **Capabilities (ADR-0064).** A shared capability map in `@labelloop/contracts` built on better-auth's standalone `createAccessControl` (already a dependency; pure) — resources like `panel`, `key`, `trace`, `trace_detail`, `annotation`, `member`; roles map to them (engineer ⊇ annotator's `annotation:create` + `trace:read`). `requirePermission({...})` replaces `requireRole`, route by route, with the existing role tests re-expressed; the console reads the same map instead of `isStaffRole`.
2. **Members (admin-only, Organisation settings' first real screen).** `org_invitations` (email, role, org, invited_by, expires_at, accepted_at) + `accountAuth`-time claim on a verified-email match; list/change-role/remove members; every write audited (`member.added`, `member.role_changed`, `member.removed`, `invitation.created/accepted/revoked`). Guard the last admin (an org must keep one). No email sending.
3. **Annotation loop.** An append-only `annotations` table: `id (ann_)`, `org_id`, `trace_id`, `panel_version_id` (copied from the trace, pinned), `annotator_id` (→ `user`, RESTRICT, per the contribution-ledger rule), `verdict` (acceptable/not), `note` (≤280, required when not acceptable), `skipped`, `sampler`, `created_at`. A per-panel queue (random over un-annotated traces, gated at 50). The annotator surface built from a reviewed `annotator-session` screen: the IN/OUT pair, equal-weight verdict buttons, required note on "not acceptable", free skip, keyboard-first, no confidence/model/cost/ids. Staff reach it via the panel's "Review traces" section.

Judge-verdict agree/correct, sampler variety, honeypots, rounds and gamification stay out; each needs judges or M6's measurement to mean anything.
