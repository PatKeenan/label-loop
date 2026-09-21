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
**M5 IS COMPLETE, PHASE 7 INCLUDED.** The annotation-sets plan shipped on 2026-09-21 in four
PRs — #96 (the rename), **#103** (sets, membership, pickers — opened as #97, see below), #98
(the queue serves an assigned set), #99 (the Annotations section) — plus #102, which parks due
dates. The plan is at `thoughts/shared/plans/complete/2026-09-21_annotation-sets.md` with 24
deviations; read those before changing anything it touches. `thoughts/shared/plans/approved/`
is EMPTY: there is no approved plan, so there is nothing to implement. **Next work starts at
`/research`.**

**Next is M6** (BUILD_SPINE): axial coding over the failure notes into a versioned taxonomy
(`tax_`), each category triaged into a `code` check or an `llm` judge; judges authored from it;
alignment sessions; agreement tracked; the eval suite gating CI. M5 exists to have produced the
notes M6 clusters.

**What M5 phase 7 leaves behind, and what a fresh session must not re-derive:**

- **The product says ANNOTATION, never review** (ADR-0085). Not a preference — `grep -ri review
  apps packages docs/adr` should return only design-review prose ("the 6b review", "reviewable
  as a diff") and two quoted historical labels in `gate.tsx` and `section-nav.tsx` that record a
  control ADR-0084 removed. An identifier, path or on-screen label saying "review" is a bug.
- **Work is an ASSIGNED SET** (ADR-0079). No panel-wide queue, no default set, no bootstrap: an
  annotator with nothing assigned has nothing to do, and the surface says so. A set you are not
  on is NOT_FOUND, the same answer as another org's.
- **A trace leaves YOUR queue when YOU answer it** (ADR-0081, superseding ADR-0066). Everyone
  assigned annotates the whole set; the overlap is how many were assigned, and that overlap is
  what M6 measures agreement from. Where answers differ the DICTATOR's counts — a rule for
  READING rows, in `countingAnswer`, computed server-side so the console and M6 cannot disagree.
- **`setProgress` is the ONE definition of answered and done** (ADR-0086), in
  `services/annotation-queue.ts`. Done is DERIVED — every CURRENTLY assigned annotator
  (`unassigned_at IS NULL`) has answered every trace — never stored. A set with no traces or
  nobody assigned is NOT done. `archived_at` is the only lifecycle column and a person writes it.
  Two counts per person and they are not interchangeable: `answered` includes skips and decides
  done, `annotated` excludes them and is what a person is shown.
- **STAFF INSPECT AND CANNOT EDIT** (ADR-0084). There is no control anywhere in the console that
  changes an annotation, and it is ABSENT rather than disabled. The one route from console to
  annotator surface is a person opening a set they are assigned to, guarded by `assignedToMe` on
  `routes/annotation-set.tsx`. `architecture.test.ts` asserts all of this.
- **`annotations.annotation_set_id` is nullable ONLY for pre-phase-7 rows**, and `sampler` now
  carries the membership row's picker rather than the constant `'random'`.
- **`annotation_set_traces` is append-only BY GRANT** (migration 0016), like `audit_events` and
  `annotations`. The app role holds INSERT and SELECT; deleting needs the migrator.
- **A Drizzle column inside a `sql` template renders UNQUALIFIED** — qualify by hand. This phase
  added more correlated subqueries than anything before it and every one of them is commented.
- **The console's CORS allow-list must name every method the router registers.** A missing one
  preflights 204 and the browser drops the real request with no server-side trace; the whole
  suite stayed green while the assign dialog silently did nothing. `routes/internal/cors.test.ts`
  now derives the rule from the router. Add a method, and that test is what tells you.
- **Two surfaces, and they do not borrow** (PRODUCT 5.5). `components/shell/` is the console's,
  `components/annotate/` is the annotator's, `components/shaped/` is the one trace renderer and
  belongs to neither. This is `architecture.test.ts`, not a paragraph, because phase 5 broke it.
- **Two `relations.test.ts` failures locally are seed-state, not regressions** (M4 Deviation 64).
- **Run the API from source** (`bun run --cwd apps/api dev`) **and restart it after changing
  routes** — `bun --hot` does not pick them up. Kill stale dev servers before running tests.
- **The repo is SQUASH-ONLY, so a stack of phase branches needs `git rebase --onto main
  <merged-parent>` between every merge.** Squashing leaves the parent's content on `main` with
  no ancestry link to the copy in the child's history, and the child then conflicts on files
  nobody touched twice. Merge only on an explicit `MERGEABLE CLEAN`, and not with
  `--delete-branch`: a refusal plus that flag closes the PR (it happened to #97 → #103).

**Open, and not blocking:** two audit-log issues found while cleaning up — #100 (`ON DELETE SET
NULL` makes a deleted org's events indistinguishable from platform-level ones, and M8 builds a
viewer on that table) and #101 (the integration suite leaks its audit rows on every run).
`docs/PARKING_LOT.md` gained due dates on an annotation set, which needs an email provider —
a stack row never taken — before the reminder half means anything.

**Phase A:** `annotator-session` is at **r7** (wording only, for ADR-0085; r6's approval stands).
`console-dashboard` stays PAUSED and is M6's. The six product decisions in
`thoughts/shared/research/2026-08-20_phase-a-design-harvest.md` stay open. The staff Annotations
section was built WITHOUT Phase A mockups — a recorded departure from screens-first, on the
grounds that the console's vocabulary was already fixed (decisions log, 2026-09-21).

(This section has been stale four times — a fresh session reads it first and treats it as
overriding. It is updated as part of closing a phase, not remembered afterwards: last on
2026-09-21, when M5 phase 7 shipped and its plan moved to `complete/`.)
