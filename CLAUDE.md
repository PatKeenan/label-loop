# CLAUDE.md — LabelLoop

## What this project is
**Judge-as-a-service with an eval-to-fine-tune flywheel** (ADR-0019). Solo-built, public portfolio project proving senior AI-engineering competency end to end. Working title: LabelLoop.

The domain model, in one paragraph, because everything else follows from it: a customer creates a **panel** (`pnl_`, immutably versioned `pnv_`) containing **judges** (`jud_`/`jdv_`), one per failure category, each a single binary question answered with reasoning *before* the verdict. **Every judge declares a two-valued polarity** — answering `true` either passes or fails (ADR-0034) — because `is-missing-repro: true` is a failure and `on-brand: true` is a success; without it the panel score is uncomputable, since summing raw booleans across judges pointing in opposite directions is meaningless. Their agent sends its **output** to the panel, with the **input** that led to it (ADR-0073: four roles — `input`, `output`, `reference`, `metadata` — each in the caller's own shape, and only the output is judged) — **we never generate the output** — and gets back a decision (`passed`, `score`, `threshold`) plus one verdict per judge, so a deterministic step can read the summary while an agent reads the reasoning. We *are* the inference path for the judge calls, which is what makes server-side trace capture and later model-swapping ours. SMEs annotate traces, axial coding turns free-text notes into a versioned **taxonomy** (`tax_`) while triaging each category into a deterministic `code` check or an `llm` judge, and the fine-tune distils expensive frontier judges into one cheap aligned model. `cls_`/`clv_` are retired.

## Source-of-truth documents (read before any work)
- `docs/PRODUCT.md` — what we are building (features, scope, non-goals, future directions)
- `docs/STAKEHOLDER_VALUE.md` — why each feature exists; traceability to the stakeholder's goals. If proposed work doesn't map to a row here, flag it as scope creep.
- `docs/BUILD_SPINE.md` — THE single ordering authority (milestones M1-M8). Every task names its milestone; anything that fits none goes to docs/PARKING_LOT.md.
- `docs/CONVENTIONS.md` — non-negotiable backend conventions (repo shape, API envelope, ids, keys, versioning, LLM-call rules).
- `docs/adr/` — accepted decisions. **ADR-0019 defines what the product IS — read it first.** ADR-0001: traces are captured server-side (we are the gateway, for judge calls). ADR-0002: REST only, no SDK. ADR-0003: immutable panel/judge versions, scoped hashed keys.
- `docs/SENIORITY_CHECKLIST.md` — the scoreboard: every competency this project exists to prove, mapped to milestone + public artifact. Check items only when the artifact is live.
- `docs/STACK_DECISIONS.md` — the technology decision register. STACK CHOICES ARE STAKEHOLDER-OWNED: never introduce a framework, database, queue, or tool for an OPEN row without asking; once decided, record an ADR.

## Methodology: screens-first, working backwards
Inspired by Amazon working-backwards press releases and HumanLayer's ACE-FCA (research → plan → implement, human review at the intention level).

1. **Phase A — Mockups as spec.** Before any application code: generate UI screens as plain, dependency-free HTML files in `mockups/`. All screens import one shared `mockups/tokens.css` (the locked style guide). See `mockups/BRIEF.md` for the screen inventory and rules.
2. **Phase B — Product release brief.** Assemble approved screens + prose into a reviewable release document. Approval happens here, not in code review.
3. **Phase C — Implementation.** Rebuild clean from the approved brief. Mockups are disposable spec, never scaffold — do not port mockup HTML into the app.

## Hard rules
- Mockups: plain HTML + CSS only. No frameworks, no build step, no JS unless a flow is meaningless without it.
- One aesthetic decision point: `tokens.css`. Mockups may not introduce ad-hoc colors, fonts, or spacing.
- Two distinct surfaces (see PRODUCT.md 5.5): the **annotator flow** (minimal, friendly, non-engineer) and the **engineer console** (dense, detailed). They share tokens but are intentionally different experiences.
- Every annotation-related schema must carry `annotator_id` and immutable dataset-version links from day one (future contribution ledger depends on it).
- Audit log design must be genuinely append-only.
- Honest results over impressive results, always — failure analysis is a deliverable.

## Working loop (research -> plan -> implement, human-driven)
This project uses the HumanLayer-style workflow via slash commands in .claude/commands/:
1. `/research <topic>` -> dense research doc in thoughts/shared/research/. STOP.
2. `/create_plan <research doc>` -> plan in thoughts/shared/plans/drafts/ with phases,
   checkboxes, verification steps, and a "Decisions made" section. STOP for steering.
3. Human reviews/steers; plan is revised in place. Approval is ALWAYS a human act.
4. `/approve_plan <draft>` -> moves to approved/, spawns ADR stubs from Decisions made.
5. Human clears context. `/implement_plan <approved plan>` -> phase-by-phase execution,
   checkbox updates, pause after each phase for manual verification.
6. `/log_decision <what>` at ANY time to capture in-conversation decisions.

## Branching
All new code lands on a feature branch and merges to `main` through a PR. NEVER commit
or push work directly to `main`. Granularity is **one branch + PR per plan phase**
(`feat/m0-p1-contracts`), matching the phase boundary where manual verification and the
context reset already happen. The PR title is the shipped commit — the repo is squash-only
with `squash_merge_commit_title=PR_TITLE` and `pr-title.yml` lints it — so it must be a
conventional-commit message, and the description names its BUILD_SPINE milestone.

Hard rules: NEVER implement from drafts/ or from conversation alone — only from
thoughts/shared/plans/approved/. Keep context utilization moderate; prefer ending a
session and starting fresh from artifacts over pushing a bloated context. The human is
the driver: when in doubt, stop and ask rather than proceed autonomously. The
thoughts/ directory is decision provenance for the public writeup — write accordingly.

## Current phase
**M4 is COMPLETE on its branch; M5 is being planned.** M4 — console, auth, and the interviewer
flow — finished with phase 8's console half, **PR #70** on `feat/m4-p8-console-screens`,
verified by the stakeholder 2026-09-18. **Merging #70 closes M4.** Its plan is in
`thoughts/shared/plans/complete/2026-09-11_m4-console-auth.md`, and Deviations 55–75 there are
the record of what phase 8 became: org creation for a member of no organisation (ADR-0063),
shared name/slug rules in `@labelloop/contracts` `names.ts`, trace pagination with live
polling, and trace detail as a drawer and a page.

**Next: members and annotation — the start of M5.** Decided in conversation on 2026-09-18
(see the decision log): **a role says what you may DO; which surface you land on is a
preference.** A developer may annotate; an annotator still cannot touch keys or panels. Two
things M5 needs that no plan owns yet: **adding a person to an org with a role** (member
management was "named by PRODUCT.md, scheduled by nothing"), and **the annotation loop**
itself. Flow: `/log_decision` → `/research` → `/create_plan`, approved by the human before any
code. better-auth's standalone `createAccessControl` (`better-auth/plugins/access`, pure, no
tables) is the candidate for permissions; its organization plugin was declined by ADR-0048 and
would collide with ADR-0014 and ADR-0047.

**What M4 leaves behind that M5 must know:**

- **The frame is ADR-0062's**: a persistent top bar, a sidebar only inside a panel, Home as panel
  cards, Create panel as a `?new` dialog. `mockups/console-shell.html` r3 no longer describes it.
- **Spacing was opened in `tokens.css`'s compact block, type untouched** — do not "fix" spacing
  by switching density. `apps/web/src/styles/tokens.css` §1–§5 are VERBATIM from
  `mockups/tokens.css`; diff them after every `shadcn add`, which writes into that file.
- **`useSurface` and `useMenuFocusReturn`** (`components/shell/`) are required on portalled
  overlays and menus respectively, or they render light on the dark console.
- **URL state:** `?org=`, `?new`, `?trace=`. TanStack Router merges a validator's result over the
  raw query, so **validators must return every key**, `undefined` when absent (Deviation 67).
- **Run the API from source** (`bun run --cwd apps/api dev`) — the compose image goes stale
  silently — **and restart it after changing routes**: `bun --hot` does not pick them up.
- **`GET /internal/traces` (the list) has no role guard** (Deviation 32); the trace DETAIL read is
  staff-only. M5's annotator surface is where "may an annotator see confidence" (harvest blocker 2)
  gets decided.
- **Two `relations.test.ts` failures locally are seed-state, not regressions** (Deviation 64).

**Phase A:** `annotator-session` and `console-dashboard` stay PAUSED until the M5 plan decides
otherwise; M5's annotator surface is exactly `annotator-session`, so that plan must say whether
Phase A resumes for it (ADR-0055 is the precedent). The six product decisions in
`thoughts/shared/research/2026-08-20_phase-a-design-harvest.md` stay open. `mockups/tokens.css`
(approved) and `tokens-preview.html` are retained; the Phase A hard rules above still apply.

(This section has been stale four times — a fresh session reads it first and treats it as
overriding. It is updated as part of closing a phase, not remembered afterwards: last on
2026-09-18, when M4 phase 8 was verified.)
