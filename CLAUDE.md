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
**M5 IS COMPLETE.** All six phases of
`thoughts/shared/plans/complete/2026-09-18_m5-members-annotation.md` shipped and the stakeholder
confirmed it on 2026-09-21: capabilities in place of role lists (#72, ADR-0064), invitations
claimed on a verified sign-in (#73, ADR-0065), the `annotator-session` mockup r6 (#74), the
`annotations` table and the queue (#84, ADR-0066, ADR-0067), the annotator surface (#85), and
annotations shown to staff on the trace drawer and page (#88).

**Next is M5 phase 7, from the ONE approved plan:**
`thoughts/shared/plans/approved/2026-09-21_annotation-sets.md` (approved 2026-09-21, #92). It
supersedes `2026-09-20_review-sets.md`, which now lives in `thoughts/shared/plans/superseded/`
with a header saying so — **implement from `approved/` only.** Four phases, in this order:
**1. the rename**, **2. the set tables and pickers**, **3. the queue serves an assigned set**,
**4. the Annotations section**. Migrations 0013–0015 are taken; annotation sets start at **0016**.

**Two ADRs from a console review on 2026-09-21 govern everything that follows** (#90, #91):

- **ADR-0084 — staff inspect annotations and CANNOT edit them.** Admins and engineers get their
  own console section; opening a set shows who is assigned, where each of them is, and what each
  of them selected on every trace. **Nobody annotates somebody else's work**: an annotation is one
  person's answer, and an engineer able to correct one would destroy the disagreement M6 exists to
  measure. Phase 5's sidebar link and gate-card button into the annotator surface are GONE (#91) —
  met in a real console they read as an ambush.
  **A developer MAY still annotate** (2026-09-21): they are assigned a set like anyone else and
  enter deliberately from their own list. Assignment draws from the org's MEMBERS, not its
  annotators. That one route is the only way from console to annotator surface, and it must never
  appear on a set you are not assigned to.
- **ADR-0085 — the product says ANNOTATION, not review.** Everywhere, the annotator surface
  included. Phase 1 of the plan is that rename; ADR-0079…0083 are renamed, not superseded.
- **ADR-0086** — a set is DONE by derivation (every assigned annotator has answered every trace,
  computed, never stored) and ARCHIVED by a person (one nullable stamp).

**TWO OPEN QUESTIONS BLOCK NOTHING BUT SHOULD BE SETTLED EARLY** (plan, open questions 2–4):
the id prefix for an annotation set (`aset_` proposed; `ans_` rejected because it reads as
*answer* beside `ann_`), whether assignment may scope someone to a panel they otherwise cannot
see, and what unassigning someone who has already answered does. The last two have drawn answers
in the plan and need confirming, not designing.

**Two surfaces, and they do not borrow from each other** (PRODUCT.md 5.5). The annotator surface
is the minimal, light one. Everything staff-facing is the dark, dense console under
`data-surface="console"`. Phase 5 broke this by accident and nothing in the code said not to; the
plan makes it an `architecture.test.ts` rule.

**What M5 leaves behind that still holds:**

- **The review API is `annotation: ['create']`** and its payload's ABSENCES are the design: no
  verdict, score, confidence, model, cost, key, trace id or `metadata` (ADR-0067, ADR-0077).
  Tests assert the payload's KEYS.
- **`annotations` is append-only BY GRANT** (migration 0015) — a changed mind is a new row, so a
  read takes the LATEST row per person. The trace detail does exactly that and counts what it
  replaced as `revisions`; the step-back control depends on the same rule.
- **`annotations.sampler` carries the picker's name** — the constant `'random'` until phase 3 of
  the new plan gives it the membership row's strategy.
- **`components/review/answer-state.ts`** holds the annotator's pure rules and MIRRORS the
  server; it is never the authority. (Phase 1 renames it.)
- **One account menu for both surfaces** (`components/shell/account-menu.tsx`) — do not
  reintroduce a second sign-out path.
- **The annotator surface reuses `components/shaped/`** under `data-surface="annotator"`. Two
  renderings of one trace would be two accounts of what was judged.
- **A Drizzle column inside a `sql` template renders UNQUALIFIED** (M5 Deviations 19 and 35, M4
  Deviation 60) — qualify by hand. Phase 4 of the new plan adds more correlated subqueries than
  anything before it.
- **Tests that read `annotations` must scope to ONE annotator** (M5 Deviation 36).
- **ADR-0073's four roles**: `input` and `output` (required), `reference` and `metadata`
  (optional). `output` is the ONE thing judged; `metadata` is withheld from the annotator
  (ADR-0077). A LEGACY trace has `input` NULL and the view says so rather than inventing one.
- **One renderer for a trace**: `apps/web/src/components/shaped/`. Markdown is `markdown-to-jsx`,
  configured once, raw HTML off (ADR-0078). `apps/api/src/llm/render-for-model.ts` is its
  judge-side twin.
- **The frame is ADR-0062's**; `apps/web/src/styles/tokens.css` §1–§5 are VERBATIM from
  `mockups/tokens.css` — diff them after every `shadcn add`.
- **`useSurface` and `useMenuFocusReturn`** are required on portalled overlays and menus.
- **URL state:** TanStack Router merges a validator's result over the raw query, so **validators
  must return every key**, `undefined` when absent (M4 Deviation 67).
- **Run the API from source** (`bun run --cwd apps/api dev`) **and restart it after changing
  routes** — `bun --hot` does not pick them up, and a stale API broke the console's trace page on
  2026-09-21 until it was restarted. Kill stale dev servers: several running at once make the
  local test suite unreadable (three "failures" of 15min, 17.8min and 3.8min on 2026-09-21).
- **Two `relations.test.ts` failures locally are seed-state, not regressions** (M4 Deviation 64).

**Phase A:** `annotator-session` r6 is approved; phase 1 of the new plan redraws it as **r7**,
wording only, for ADR-0085. `console-dashboard` stays PAUSED. The six product decisions in
`thoughts/shared/research/2026-08-20_phase-a-design-harvest.md` stay open. **The staff Annotations
section is built WITHOUT Phase A mockups** — a recorded departure from screens-first, on the
grounds that the console's vocabulary is already fixed and Traces, Keys and Members were all built
straight from it (decisions log, 2026-09-21).

(This section has been stale four times — a fresh session reads it first and treats it as
overriding. It is updated as part of closing a phase, not remembered afterwards: last on
2026-09-21, when M5 completed (#88) and the annotation-sets plan was approved (#92), after
ADR-0084 and ADR-0085 came out of a console review (#90, #91).)
