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
**M5 is mid-flight, and the evaluate contract underneath it has been replaced.** M5's plan
(`thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md`) shipped phases 1–3:
capabilities in place of role lists (#72, ADR-0064), invitations claimed on a verified sign-in
(#73, ADR-0065), and phase 3's `annotator-session` mockup — **r6, approved and merged (#74,
2026-09-20)**, redrawn against the transcript layout the shaped view uses. **M5 resumes at
phase 4**: the `annotations` table (migration 0015) and the review queue.

**ADR-0073 landed in between, and it is the thing to read first.** `POST /v1/…/evaluate` takes
**four roles** — `input` and `output` (required, any JSON), `reference` and `metadata`
(optional) — instead of `artifact` + `context`, which are **gone from the database**. Shipped
2026-09-20 as #77–#81 from
`thoughts/shared/plans/complete/2026-09-19_evaluate-native-shapes.md`; ADR-0074 (expand,
dual-write, contract), ADR-0075 (64 KiB cap), ADR-0076, ADR-0077, ADR-0078 (markdown).

**What that leaves for the rest of M5:**

- **`output` is the ONE thing judged** — the agent's final answer or proposal. Everything that
  led to it is `input`: evidence, never on trial. `reference` is facts only the judge needs;
  `metadata` is bookkeeping and **is withheld from the annotator payload** (ADR-0077).
- **Migrations 0013 and 0014 are TAKEN.** M5 phase 4's annotations migration is **0015**.
- **One renderer for a trace, and phase 5 reuses it**: `apps/web/src/components/shaped/`
  (`to-steps.ts` pure, `markdown.tsx`, `shaped-trace.tsx`), token-only so the annotator surface
  gets it unchanged under `data-surface="annotator"`. Do not write a second one.
- **Markdown is `markdown-to-jsx`, configured once** in `shaped/markdown.tsx`: raw HTML off,
  http(s)/mailto links only, images never fetched (STACK_DECISIONS D18, ADR-0078).
- **Tool calls are recognised in OpenAI and Anthropic formats only.** A framework's own step
  list is stored and judged identically and reads as fields — parked, with its promotion
  condition, in `docs/PARKING_LOT.md`.
- **A LEGACY trace has `input` NULL** (4,593 of them locally, including 47 from the spike whose
  encoded roles live on in `reference`). The view says "recorded before inputs were captured"
  rather than inventing one. Phase 4's queue and review payload must expect it.
- **`apps/api/src/llm/render-for-model.ts`** is the judge-side twin of `to-steps.ts`: one pure
  function, every adapter. A judge never formats its own prompt.

**What M4 left behind that still holds:**

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

**Phase A:** `annotator-session` r6 is drawn and APPROVED (#74) — phase 5 builds from it, and
its two open questions (Q5 long outputs, Q6 whether an annotator sees tool steps) are decided
there, in code. `console-dashboard` stays PAUSED. The six product decisions in
`thoughts/shared/research/2026-08-20_phase-a-design-harvest.md` stay open. `mockups/tokens.css`
(approved) and `tokens-preview.html` are retained; the Phase A hard rules above still apply.

(This section has been stale four times — a fresh session reads it first and treats it as
overriding. It is updated as part of closing a phase, not remembered afterwards: last on
2026-09-20, when M5 phase 3's r6 mockup was approved and merged (#74), after the native-shapes
plan completed in #77–#81.)
