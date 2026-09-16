# CLAUDE.md — LabelLoop

## What this project is
**Judge-as-a-service with an eval-to-fine-tune flywheel** (ADR-0019). Solo-built, public portfolio project proving senior AI-engineering competency end to end. Working title: LabelLoop.

The domain model, in one paragraph, because everything else follows from it: a customer creates a **panel** (`pnl_`, immutably versioned `pnv_`) containing **judges** (`jud_`/`jdv_`), one per failure category, each a single binary question answered with reasoning *before* the verdict. **Every judge declares a two-valued polarity** — answering `true` either passes or fails (ADR-0034) — because `is-missing-repro: true` is a failure and `on-brand: true` is a success; without it the panel score is uncomputable, since summing raw booleans across judges pointing in opposite directions is meaningless. Their agent sends an artifact to the panel — **we never generate the artifact** — and gets back a decision (`passed`, `score`, `threshold`) plus one verdict per judge, so a deterministic step can read the summary while an agent reads the reasoning. We *are* the inference path for the judge calls, which is what makes server-side trace capture and later model-swapping ours. SMEs annotate traces, axial coding turns free-text notes into a versioned **taxonomy** (`tax_`) while triaging each category into a deterministic `code` check or an `llm` judge, and the fine-tune distils expensive frontier judges into one cheap aligned model. `cls_`/`clv_` are retired.

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
**M4 — console, auth, and the interviewer flow** (docs/BUILD_SPINE.md), from
`thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md`. M0–M3 are complete (their
plans are in `thoughts/shared/plans/complete/`), and two M5 polarity plans landed early. M4
phases 1–5 — the backend half — are merged (#58–#63), and **phase 6, the human review gate,
is merged as #65**. **Next is phase 7**: the frame, BUILT — Tailwind + shadcn/ui, the
`tokens.css` conversion (ADR-0046, and its two alias rules are load-bearing), and the sidebar
shell drawn in `mockups/console-shell.html` r3.

**Phase 8's scope changed underneath it — read the plan's Deviations 32–41 before planning or
implementing it.** Two decisions taken during phase 6's review moved the milestone:
**ADR-0060** (a panel COLLECTS before it judges, moved from M5 into M4) and **ADR-0061**
(judges are authored only from an eval pass). So phase 8 no longer builds a judge wizard or a
model-picker UI — both move to M6 beside the taxonomy — and instead builds one-step panel
creation, a panel Overview that onboards (collecting state, progress toward the 50-trace
annotation gate, an integration snippet), a key issued WITH the panel, a locked Judges
section, and the `/v1` contract change that makes a judgeless panel legitimate. BUILD_SPINE's
M4 deliverables and demo moment were rewritten to match.

**Phase A's partial resume is COMPLETE** (ADR-0055). All three artifacts were reviewed and
approved 2026-09-14/15: `mockups/CONSOLE_FLOW.md`, `mockups/console-shell.html` (r3) and
`mockups/panel-create.html` (r3). Phase 7 and 8 build from those screens and never port their
HTML (Phase C). `annotator-session` and `console-dashboard` stay PAUSED, and the six product
decisions in `thoughts/shared/research/2026-08-20_phase-a-design-harvest.md` stay open — none
of them gated these three. `mockups/tokens.css` (approved) and `tokens-preview.html` are
retained; the Phase A hard rules above still apply in full. See `mockups/BRIEF.md`.

(This section read "backend-first: M0 is the priority, Phase A is PAUSED" until 2026-09-14,
three milestones after it stopped being true, and was corrected before a context reset —
because a fresh session reads this file first and treats it as overriding, and would have
stalled or refused at phase 6. Updated again on 2026-09-15 for the same reason: phase 6 is
done, and a session starting from the stale text would have built a wizard that two ADRs
had just removed.)
