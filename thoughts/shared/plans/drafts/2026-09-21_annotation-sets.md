---
date: 2026-09-21T03:00:00Z
author: claude-code
status: draft
supersedes: thoughts/shared/plans/approved/2026-09-20_review-sets.md
milestone: M5 (phase 7, after "Seeing the annotations")
topic: annotation-sets
related_adrs: [0003, 0019, 0061, 0064, 0066, 0067, 0073, 0077, 0079, 0080, 0081, 0082, 0083, 0084, 0085]
research: thoughts/shared/research/2026-09-20_engineer-curated-review-sets.md
---

# Annotation sets, and the console section that reads them

## Why this replaces the approved plan
`2026-09-20_review-sets.md` was approved on 2026-09-20 and is **not wrong** — its three tables,
four pickers, 250 cap, assignment model and dictator rule all stand, and ADR-0079…0083 stand with
them. Three things changed when the stakeholder met phase 6 in a running console on 2026-09-21,
and each one reaches far enough into the plan that editing it in place would leave the record
unreadable:

1. **Staff are never routed into the annotator surface** (ADR-0084). The approved phase 3 already
   moved the sidebar's link target for staff, but it drew the staff screen as a set list with
   progress. It is now a section in its own right: opening a set shows **who is assigned, how far
   each of them has got, and what each of them selected on every trace** — and it is READ-ONLY
   with respect to answers, because nobody annotates somebody else's work.
2. **The product says annotation, not review** (ADR-0085) — the annotator surface included. That
   is a rename of everything the approved plan was about to add, plus everything M5 phases 4 and 5
   already shipped under the old word.
3. **A set is DONE by derivation and ARCHIVED by a person.** The approved plan stored
   `completed_at`. It no longer stores done at all.

Everything below that is unchanged from the approved plan is marked **(unchanged)**, so review can
go straight to what moved.

## The rule this plan exists to keep
**Two surfaces, and they do not borrow from each other** (CLAUDE.md, PRODUCT.md 5.5). The
annotator surface is the minimal, friendly, light one, for a non-engineer answering one question at
a time. Everything in this plan that a developer or admin touches is the **engineer console**:
dark, dense, inside `ConsoleShell`, under `data-surface="console"`, with the same `PageHead`,
`panelTrail`, sidebar, table and `Mark`/`Data` idioms as Traces and Keys. No staff screen reuses an
annotator component, no annotator screen gains a console one, and the word "review" appears in
neither.

Stated this plainly because phase 5 broke it by accident and nothing in the code said not to.

---

## Phase 1 — The vocabulary: annotation, not review

**A rename, and nothing else.** No behaviour changes, no table changes, no new screen. It lands
first so every later phase is written in the final vocabulary rather than renamed afterwards, and
it is reviewable as a single mechanical diff.

### Changes
- **API**: `routes/internal/review.ts` → `annotate.ts`; paths `/review/*` → `/annotate/*`.
  `services/annotation-queue.ts` keeps its name — it was already right.
- **Console/web**: `routes/review.tsx` → `annotate.tsx`, `routes/review-session.tsx` →
  `annotate-session.tsx`, `components/review/` → `components/annotate/`
  (`answer-state.ts`, `review-frame.tsx` → `annotate-frame.tsx`). Web routes `/review` →
  `/annotate`, `/review/$panelSlug` → `/annotate/$panelSlug` (the param becomes `$setId` in
  phase 3). `router.tsx`'s landing redirect follows.
- **Words on screen**: `root.tsx`'s "Reviewing happens over here" / "Go to Review" become
  "Annotating happens over here" / "Go to annotate". The annotator surface stops saying review.
- **ADR titles and bodies**: 0079…0083 renamed in place — **the decisions do not change**, their
  noun does. A one-line note in each records the rename and points at ADR-0085.
- **Mockup**: `mockups/annotator-session.html` **r7** — wording only, no layout change, no new
  open questions. The stakeholder approved r6 on 2026-09-20 under the old word; r7 is that screen
  with the word corrected.
- `docs/CONVENTIONS.md`, `docs/PRODUCT.md`, `docs/BUILD_SPINE.md` — occurrences of "review" that
  mean annotation.

### Steps
- [ ] API routes and file moved; every path renamed
- [ ] Web routes, components and directory moved; landing redirect follows
- [ ] On-screen words, including the annotator surface
- [ ] ADR-0079…0083 renamed with a pointer to ADR-0085; r7 drawn
- [ ] Docs swept

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`
- [ ] `grep -ri 'review' apps packages docs/adr` returns only historical prose (deviation notes,
      "reviewed by", this plan's own account of the rename) — no identifier, path or label

### Manual verification
- [ ] As an annotator, the surface works exactly as before and says annotate throughout

---

## Phase 2 — The annotation set, its membership, and the pickers

**(Unchanged from approved phase 1 except the nouns and the lifecycle columns.)**

### Changes
- `packages/db/migrations/0016_annotation_sets.sql` + `schema/annotation-sets.ts`:
  - `annotation_sets`: `id (aset_)`, `org_id`, `panel_id`, `name`, `created_by` (→ `user`,
    RESTRICT), `archived_at` (nullable), `created_at`. UNIQUE `(panel_id, lower(name))`.
    **No membership column, no count, no `is_default`** (unchanged reasoning: derivable, and a
    cached count goes wrong silently).
    - **`completed_at` is GONE.** Done is derived, never stored (new): every assigned annotator
      has answered every trace in the set. A stamp would be wrong the moment a third annotator is
      assigned to a finished set — the set genuinely is not done any more, and a stored flag would
      say it was. `archived_at` is the only lifecycle column, and it records a PERSON's act:
      putting a finished — or abandoned — pass away.
  - `annotation_set_annotators`: `annotation_set_id`, `user_id` (→ `user`, RESTRICT),
    `is_dictator`, `assigned_by`, `assigned_at`, `unassigned_at` (nullable).
    PK `(annotation_set_id, user_id)`; partial UNIQUE on `(annotation_set_id) WHERE is_dictator`.
    Assignment is what makes work exist; unassigning is a stamp, never a delete. (unchanged)
  - `annotation_set_traces`: `annotation_set_id`, `trace_id`, `strategy`
    (`manual | latest_n | earliest_n | random_n`), `added_at`, `added_by`.
    PK `(annotation_set_id, trace_id)`; **append-only by GRANT**. (unchanged)
  - `aset_` added to `ID_PREFIXES`. **Open question 4** — `ans_` was the obvious contraction and
    is rejected here: "ans" reads as *answer* in a product whose central object is an answer.
- `packages/contracts/src/annotation-sets.ts` — strategies, size bounds
  (1…`ANNOTATION_SET_MAX_SIZE` = **250**), request schemas, name rule from `names.ts`. (unchanged)
- `packages/contracts/src/capabilities.ts` — `annotation` gains `curate`, held by `admin` and
  `engineer`. (unchanged, ADR-0083)
- `apps/api/src/services/annotation-sets.ts` — `resolveTraces`, `createAnnotationSet`,
  `topUpAnnotationSet`, each with its audit event carrying strategy and count, never trace ids.
  (unchanged)
- `apps/api/src/routes/internal/annotation-sets.ts`, `annotation: ['curate']`:
  `GET|POST /panels/:slug/annotation-sets`, `POST /annotation-sets/:id/top-up`,
  `PUT /annotation-sets/:id/annotators`, and **`POST /annotation-sets/:id/archive`** (new — the
  one lifecycle write). Two or more annotators and no dictator is a 422. (otherwise unchanged)

### Steps
- [ ] Migration 0016, schema, grants, `aset_` prefix
- [ ] Contracts: strategies, sizes, name rule, `annotation: ['curate']`
- [ ] `resolveTraces` and the writes, each audited
- [ ] Routes, including archive, with role × route matrix rows
- [ ] Tests: each picker returns what it says; membership append-only by grant (SQLSTATE 42501);
      a top-up re-picking a trace adds nothing; a duplicate name is a 422; the audit event carries
      no trace ids; unassigning keeps the row; two annotators with no dictator is refused and a
      second dictator is refused by the database; **archiving is a stamp and does not change
      whether the set is done**

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] Create a random-25 set on `support-chat` by `curl`; `psql` shows 25 membership rows with the
      strategy; top it up by 25 and see 50, the new ones with a later `added_at`

---

## Phase 3 — The queue serves an ASSIGNED set

**(Unchanged from approved phase 2 except the nouns and the removal of the `completed_at` write.)**

### Changes
- `apps/api/src/services/annotation-queue.ts` — the pool becomes membership, and **rule 2 becomes
  per-person**: a trace leaves YOUR queue when YOU have answered it. **Supersedes ADR-0066's
  one-person-per-trace** (ADR-0081). Skip rule untouched. `nextItem(setId, annotatorId)`;
  `previousItem` scopes to the set; `listAnnotationSets` returns **the sets assigned to this
  person**, with size, answered and remaining. An unassigned set is NOT_FOUND. (unchanged)
- **Done is computed here, not stamped** (changed): one function, `setProgress`, answering size,
  per-annotator answered counts and therefore done — used by the annotator's list, by the staff
  section (phase 4), and by nothing else. **One definition of done, or the two screens will
  disagree.**
- **No default set and no bootstrap path.** (unchanged)
- **Reading a disagreement is a RULE, not a workflow**: where answers differ, the dictator's
  counts. (unchanged, ADR-0081)
- `annotations.annotation_set_id` (nullable, RESTRICT) — nullable only for rows written before
  this phase. `annotations.sampler` carries the membership row's strategy rather than the constant
  `'random'`. (unchanged)
- `apps/api/src/routes/internal/annotate.ts` — `/annotate/sets`, `/annotate/sets/:id/next`,
  `/annotate/sets/:id/previous`; the write takes the set id. Payload absences unchanged
  (ADR-0067, ADR-0077); the set's NAME reaches the annotator, its strategy does not. (unchanged)

### Steps
- [ ] Queue pool from membership; `listAnnotationSets`; next/previous by set
- [ ] `setProgress` — the one definition of answered and done
- [ ] Sets scoped to assignments; an unassigned set is NOT_FOUND
- [ ] `annotations.annotation_set_id` + `sampler` from the membership row
- [ ] Routes moved to sets; the old panel routes removed
- [ ] Tests: a set's queue never serves a trace outside it; **two annotators on one set each get
      the whole set, and neither is served a trace twice**; the floor still refuses; `sampler`
      records the picker; where two answers differ the dictator's is what a read returns;
      **a done set becomes not-done when a third annotator is assigned** (the derivation's point)

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] As an annotator with nothing assigned, the surface says so and offers nothing; assign a set
      as an engineer, reload, and it appears; annotations carry its id

---

## Phase 4 — The Annotations section: sets, assignment, and who said what

**This is the phase the stakeholder's feedback added, and it replaces approved phase 3's console
half.** It is the engineer console throughout (see "The rule this plan exists to keep").

### What a developer can and cannot do here
- **Can**: create a set, pick its traces, name it, assign annotators, name the dictator, top it
  up, archive it, and read everything anybody answered.
- **Cannot**: change, delete, re-answer or override a single annotation. **Nobody annotates
  somebody else's work** (ADR-0084). No answer control appears on this surface at all — not
  disabled, absent. Where a developer thinks an answer is wrong, the remedy is another annotator
  on the set (ADR-0081), not an edit.

### Changes
- `apps/web/src/routes/annotations.tsx` (new) — **`/p/$panelSlug/annotations`**, the panel's
  Annotations section: a table of its sets with name, size, how many traces are answered, the
  assigned annotators, and **state — active / done / archived**, derived and stamped as phase 2
  and 3 define. An **archived** filter, defaulting to hiding them: an archive nobody can see is
  a delete, and an archive always on screen is not an archive. **New annotation set** opens a
  dialog (name, strategy, size, with the count it will take shown before it runs) — the same
  `?new`-style dialog posture the panel create uses (ADR-0062).
- `apps/web/src/routes/annotation-set.tsx` (new) — **`/p/$panelSlug/annotations/$setId`**, one
  set:
  - **Who is assigned, and where each of them is** — one row per annotator: name, answered of
    size, a progress bar, whether they are the dictator, and when they were assigned. An
    unassigned annotator stays listed, marked, with their answers intact (open question 3).
  - **The set's traces, one row each, with EVERY annotator's answer on that row** — so
    disagreement is visible by scanning down a column rather than by opening anything. Where
    answers differ, the dictator's is marked as the one that counts. Unanswered cells say so.
  - **Assign annotators** and **Top up** and **Archive**, all `annotation: ['curate']`.
  - Clicking a trace row opens **the trace drawer M5 phase 6 built** — which already renders the
    annotations block, read-only, one entry per person with their note. **One rendering of a
    trace's answers, reused; not a second one.**
- `apps/web/src/components/shell/section-nav.tsx` — the **Annotations** row, inert since the
  phase 6 follow-up, becomes live. It keeps the floor lock (ADR-0061).
- `apps/web/src/components/shell/gate.tsx` — the card gains its way in again, and this time it
  stays in the console: **Annotations**, to this section.
- `apps/web/src/routes/traces.tsx` — row checkboxes and **New annotation set** from the selection
  (manual picking reuses the table an engineer is already reading). (unchanged from approved)
- `apps/api/src/routes/internal/annotation-sets.ts` — `GET /annotation-sets/:id`, staff
  (`annotation: ['curate']`): the set, its annotators with `setProgress`, and its traces with
  every annotator's answer. **The staff read is the only place confidence-free withholding does
  not apply** — it is `trace: ['read']` territory, which annotators do not have (ADR-0067 is
  about what reaches the ANNOTATOR, not about what staff may see).

### Steps
- [ ] `GET /annotation-sets/:id` — set, annotators with progress, traces with answers
- [ ] Annotations section: the set table, state filter, create dialog
- [ ] One set: annotator progress, the trace × annotator answer grid, assign / top up / archive
- [ ] Trace rows open the phase 6 drawer — no second rendering of an answer
- [ ] Sidebar row live; gate card points here
- [ ] Trace-table selection → New annotation set
- [ ] Tests: the staff read returns every annotator's answer and the dictator marking; a set in
      another org is NOT_FOUND; an **annotator** calling the staff read is FORBIDDEN; `bun test
      apps/web` covers the pure parts (state derivation for the badge, the create form's rules)

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`
- [ ] **No annotator component is imported by a console route, and no console component by the
      annotator surface** — asserted in `architecture.test.ts`, which already owns this kind of
      rule. The two-surface rule becomes a test rather than a paragraph.

### Manual verification
- [ ] As an engineer: select six traces by hand, make a set, assign two annotators, name a
      dictator. As each annotator, answer some. Back in the console: both annotators' progress is
      right, the trace grid shows both answers side by side, disagreements are visible, and the
      dictator's is marked. **Nothing on the screen offers to change an answer.**
- [ ] Archive the set; it leaves the default list and is still readable behind the filter
- [ ] The console never changes appearance — the section looks like Traces, not like the
      annotator surface

---

## Decisions carried from the approved plan
ADR-0079 (annotation runs against an assigned set), ADR-0080 (membership is a snapshot), ADR-0081
(everyone assigned reviews the whole set; the dictator's answer counts), ADR-0082 (capped at 250),
ADR-0083 (curating is its own capability) — **all stand**, renamed by ADR-0085.

## Decisions new to this plan
1. **ADR-0084** — staff inspect annotations on a console surface of their own and cannot edit them.
2. **ADR-0085** — the product says annotation, not review, the annotator surface included.
3. **Done is derived; archived is a stamp** — needs an ADR stub at approval (next free: 0086).
4. **The staff section needs no Phase A mockup.** It is built from the console's existing
   idioms — `PageHead`, `panelTrail`, the trace table, `Mark`/`Data`, the `?new` dialog — which
   ADR-0062 already fixed and which Traces, Keys and Members were all built from directly.
   `annotator-session` got Phase A treatment because it is the OTHER surface, where there was no
   established vocabulary. **Overrule this if you want to see it drawn first** — it is the one
   place this plan departs from screens-first, and the reason is that the screens already exist.

## Explicitly NOT doing
(unchanged from the approved plan) A split queue, an arbitration screen, a resolution object;
inter-annotator agreement as a METRIC (M6); alignment sessions (M6); low-confidence and
judge-disagreement pickers (M6); honeypots; sets spanning panels; removing traces from a set;
sharing a set between orgs.

Added: **no staff annotation surface.** Whether a developer may be assigned a set and annotate
their own traces is open question 5; what is settled is that they never reach the annotator
surface from the console.

## Open questions for the human
1. **The two one-line document edits, still owed** (carried, unanswered): PRODUCT.md 5.5 gains the
   set, assignment and the dictator; BUILD_SPINE M5's "Not now: multi-annotator consensus" becomes
   "recording overlaps; consensus metrics stay M6".
2. **Can a person be assigned a set in a panel they otherwise cannot see?** (carried, unanswered)
   Membership is org-wide, so assignment is currently the only thing narrowing an annotator to a
   panel — either a happy accident or the panel-scoping deferral arriving early.
3. **Unassigning someone who has already answered** (carried, unanswered) — drawn as: the stamp is
   set, their answers stay and stay visible in the section, and the set can no longer complete on
   them.
4. **`aset_` as the id prefix** (new) — `ans_` reads as *answer*. `aset_` is five characters where
   most prefixes are four; `tr_` is already three, so the convention is not fixed.
5. **May a developer or admin be ASSIGNED a set and annotate their own traces?** (new) ADR-0084
   settles only that the console never delivers them into the annotator surface sideways. If yes,
   assignment lists staff too and they reach it from their own list, deliberately. If no,
   assignment is annotators-only and M5 decision 3 is fully revoked.
