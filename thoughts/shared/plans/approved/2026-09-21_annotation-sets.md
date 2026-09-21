---
date: 2026-09-21T03:00:00Z
author: claude-code
status: approved
approved_at: 2026-09-21T04:10:00Z
approver: Pat Keenan
supersedes: thoughts/shared/plans/approved/2026-09-20_review-sets.md
milestone: M5 (phase 7, after "Seeing the annotations")
topic: annotation-sets
related_adrs: [0003, 0019, 0061, 0064, 0066, 0067, 0073, 0077, 0079, 0080, 0081, 0082, 0083, 0084, 0085, 0086]
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
- [x] API routes and file moved; every path renamed
- [x] Web routes, components and directory moved; landing redirect follows
- [x] On-screen words, including the annotator surface
- [x] ADR-0079…0083 renamed with a pointer to ADR-0085; r7 drawn
- [x] Docs swept

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`
      (996 pass / 2 fail — both `relations.test.ts`, the known seed-state failures, M4 Deviation 64)
- [x] `grep -ri 'review' apps packages docs/adr` returns only historical prose (deviation notes,
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
  one lifecycle write). **A call that would leave two or more assigned annotators with no
  dictator is a 422 — whether it names none, or unassigns the one there is** (open question 6,
  answered 2026-09-21). One rule in both directions, so no ordering of calls reaches a set with a
  disagreement and nobody to settle it. (otherwise unchanged)

### Steps
- [x] Migration 0016, schema, grants, `aset_` prefix
- [x] Contracts: strategies, sizes, name rule, `annotation: ['curate']`
- [x] `resolveTraces` and the writes, each audited
- [x] Routes, including archive, with role × route matrix rows
- [x] Tests: each picker returns what it says; membership append-only by grant (SQLSTATE 42501);
      a top-up re-picking a trace adds nothing; a duplicate name is a 422; the audit event carries
      no trace ids; unassigning keeps the row; two annotators with no dictator is refused and a
      second dictator is refused by the database; **unassigning the dictator is refused unless the
      same call names another, and accepted when it does**; **archiving is a stamp and does not change
      whether the set is done**

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`
      (1045 pass / 2 fail — both `relations.test.ts`, the known seed-state failures, M4 Deviation 64)

### Manual verification
- [x] Create a random-25 set on `support-chat` by `curl`; `psql` shows 25 membership rows with the
      strategy; top it up by 25 and see 50, the new ones with a later `added_at`
      — done on `demo`/`brixadi-brand-taste` (see Deviation 8); 25 rows all `random_n` with one
      `added_at`, then 50 DISTINCT traces across two `added_at` batches. The dictator rule was
      checked the same way: two annotators and no dictator is a 422, and the same call naming
      one is a 200.

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
- [x] Queue pool from membership; `listAssignedSets` (see Deviation 10); next/previous by set
- [x] `setProgress` — the one definition of answered and done
- [x] Sets scoped to assignments; an unassigned set is NOT_FOUND
- [x] `annotations.annotation_set_id` + `sampler` from the membership row (migration 0017)
- [x] Routes moved to sets; the old panel routes removed
- [x] Tests: a set's queue never serves a trace outside it; **two annotators on one set each get
      the whole set, and neither is served a trace twice**; the floor still refuses; `sampler`
      records the picker; where two answers differ the dictator's is what a read returns;
      **a done set becomes not-done when a third annotator is assigned** (the derivation's point)

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`
      (1062 pass / 2 fail — both `relations.test.ts`, the known seed-state failures, M4 Deviation 64)

### Manual verification
- [x] As an annotator with nothing assigned, the surface says so and offers nothing; assign a set
      as an engineer, reload, and it appears; annotations carry its id
      — done in the browser as `annotator@labelloop.test`: "Nothing assigned yet / Work appears
      here when somebody assigns you a set", then after a `PUT .../annotators` the set appears by
      NAME with its panel and "50 left". Two answers written; both rows carry the `aset_` id and
      `sampler = 'random_n'`, the picker that filled that set. The one pre-phase-7 row still has
      `annotation_set_id` NULL, which is what the column being nullable is for.

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
- [x] `GET /annotation-sets/:id` — set, annotators with progress, traces with answers
- [x] Annotations section: the set table, state filter, create dialog
- [x] One set: annotator progress, the trace × annotator answer grid, assign / top up / archive
- [x] Trace rows open the phase 6 drawer — no second rendering of an answer
- [x] Sidebar row live; gate card points here
- [x] Trace-table selection → New annotation set
- [x] Tests: the staff read returns every annotator's answer and the dictator marking; a set in
      another org is NOT_FOUND; an **annotator** calling the staff read is FORBIDDEN (see
      Deviation 21 for the pure web tests)

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`
      (1081 pass / 2 fail — both `relations.test.ts`, the known seed-state failures, M4 Deviation 64)
- [x] **No annotator component is imported by a console route, and no console component by the
      annotator surface** — asserted in `architecture.test.ts`, which already owns this kind of
      rule. The two-surface rule becomes a test rather than a paragraph.

### Manual verification
- [x] As an engineer: select six traces by hand, make a set, assign two annotators, name a
      dictator. As each annotator, answer some. Back in the console: both annotators' progress is
      right, the trace grid shows both answers side by side, disagreements are visible, and the
      dictator's is marked. **Nothing on the screen offers to change an answer.**
      — done in the browser on `demo`/`brixadi-brand-taste`. Six ticked in the trace table → "6
      selected · New annotation set" → the dialog with no strategy control and "Takes 6 selected
      traces" → straight into the set. Assigning two with no dictator disabled Save and said why;
      naming one saved. Both answered two traces, disagreeing on the first: the grid reads
      `ACCEPTABLE | NOT ACCEPTABLE note | ACCEPTABLE by dictator` on that row and
      `NOT ACCEPTABLE | NOT ACCEPTABLE note | NOT ACCEPTABLE` (no "by dictator") on the one they
      agreed about. Unanswered rows read `—`. A trace row opens the phase 6 drawer with both
      answers and their notes. **This is also where the CORS bug was found — see Deviation 19.**
- [x] Archive the set; it leaves the default list and is still readable behind the filter
      — the list says "1 set shown · Show archived (1)"; the toggle puts `?archived=true` in the
      URL and the archived row back. The archived set's own page drops Assign / Top up / Archive.
- [x] The console never changes appearance — the section looks like Traces, not like the
      annotator surface

---

## Decisions made

### Carried from the superseded plan
ADR-0079 (annotation runs against an assigned set), ADR-0080 (membership is a snapshot), ADR-0081
(everyone assigned reviews the whole set; the dictator's answer counts), ADR-0082 (capped at 250),
ADR-0083 (curating is its own capability) — **all stand**, renamed by ADR-0085.

### New to this plan
1. **ADR-0084** — staff inspect annotations on a console surface of their own and cannot edit them.
   Shipped ahead of this plan (#90), with the console fix it justifies (#91).
2. **ADR-0085** — the product says annotation, not review, the annotator surface included.
   Shipped ahead of this plan (#90).
3. **ADR-0086 — done is derived; archived is a stamp.** Stub spawned at approval.
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

Added: **no staff annotation surface.** A developer who is assigned a set annotates on the
ANNOTATOR surface, like everybody else (open question 5, answered) — there is no console-shaped
way to answer a trace, and building one would be two renderings of one act. What ADR-0084 forbids
is arriving there without having chosen to.

## Open questions for the human
> **ALL ANSWERED** (2026-09-21) — the four carried into this plan, and question 6, which fell
> out of question 3. Nothing here blocks implementation. They are kept, struck through, because
> the answers and their consequences are the record.
1. ~~**The two one-line document edits, still owed**~~ — **DONE at approval, 2026-09-21.**
   PRODUCT.md 5.5 gained the set, its assignment, the dictator and the staff read; BUILD_SPINE
   M5's "Not now: multi-annotator consensus" became "consensus METRICS stay M6; M5 records the
   overlaps they will be computed from". Owed since 2026-09-20 and carried twice. **Check the
   wording — it is yours, and I wrote it.**
2. ~~**Can a person be assigned a set in a panel they otherwise cannot see?**~~ —
   **ANSWERED: YES** (stakeholder, 2026-09-21), and the framing is confirmed: membership is
   org-wide, so **assignment is the only thing narrowing an annotator to a panel.** It is the
   panel-scoping deferral arriving early, not an accident — `docs/PARKING_LOT.md` is updated to
   say so, because that entry claimed M5's annotator would see every panel's queue, which stops
   being true here.

   **The consequence is a security property and must be written as one: assigning somebody a set
   GRANTS THEM READ ACCESS to those traces' `input`, `output` and `reference`** through the
   annotate queue, in a panel they can otherwise reach nothing of. They still cannot read the
   panel, its judges, its keys or the trace list — the queue is the whole of their access
   (ADR-0067) and `metadata` is withheld (ADR-0077). But `PUT /annotation-sets/:id/annotators` is
   an access-granting write, not bookkeeping, which is why it is `annotation: ['curate']`
   (ADR-0083) and why its audit event matters.

   It does NOT solve the agency case in PARKING_LOT — nothing stops an annotator being assigned
   sets from two competing brands' panels, and there is still no way to say "this person may
   never see Brand B". That needs the member × panel grant, designed once with M8's guest access.
3. ~~**Unassigning someone who has already answered**~~ — **ANSWERED: YES, as drawn**
   (stakeholder, 2026-09-21). `unassigned_at` is stamped, never a delete. Their answers stay, stay
   visible in the Annotations section, and stay in the record M6 measures agreement from — the
   work was done and the row is append-only.

   **This sharpens ADR-0086's derivation, and the plan is binding on it**: done is *every
   CURRENTLY assigned annotator has answered every trace* — `unassigned_at IS NULL`. Reading it
   as "every assigned annotator" would let one unassigned person block a set from ever completing,
   which is the opposite of what unassigning is for. `setProgress` owns that, once.
4. ~~**`aset_` as the id prefix**~~ — **ANSWERED: `aset_`** (stakeholder, 2026-09-21). The
   reasoning now lives where the next person will need it rather than in this plan:
   **CONVENTIONS.md "Id prefixes"** carries the full table (live / reserved / retired) and the
   rules for choosing one, with `ans_` as the worked example of a prefix that is distinct from
   `ann_` and still indistinguishable from it in use.
5. ~~**May a developer or admin be ASSIGNED a set and annotate their own traces?**~~ —
   **ANSWERED: YES** (stakeholder, 2026-09-21). So M5 decision 3 is **revised, not revoked**: a
   developer may annotate; what they may not do is arrive by accident. Three consequences, and
   they are binding on the phases above:
   - **Phase 2**: `PUT /annotation-sets/:id/annotators` assigns from the org's MEMBERS, not from
     its annotators — an admin or engineer is an assignable person, and may be the dictator.
   - **Phase 3**: the queue already keys on `annotator_id` and asks no question about role, so a
     staff member with `annotation: ['create']` is served their assigned set like anyone else.
     Nothing to change; worth a test that says so, because "annotators only" is the assumption a
     future reader will bring.
   - **Phase 4**: a staff member who is assigned sees it in the Annotations section, with a
     deliberate way in — their own set, chosen. **This is the ONLY route from the console to the
     annotator surface, and it is a person picking up work assigned to them, which is the
     opposite of the ambush ADR-0084 closed.** It must not appear on a set they are not assigned
     to, because that would be the old door with a new label.
6. ~~**Unassigning the DICTATOR**~~ — **ANSWERED: refused unless the same call names another**
   (stakeholder, 2026-09-21), chosen with the read-rule consequence stated: the dictator rule is
   a READ rule (ADR-0081), so changing who holds it **re-reads every past disagreement in that
   set** — their old answers stop winning retroactively. Inherent to "a disagreement is two rows
   and a rule for reading them", and now a known property rather than a surprise.

   Binding on phase 2's route: `PUT /annotation-sets/:id/annotators` refuses (422) any call that
   would leave a set with two or more assigned annotators and no dictator — whether by naming
   none in the first place or by unassigning the one it has. **One rule, both directions**, so
   there is no ordering of calls that reaches a set with a disagreement and nobody to settle it.
   Their past answers stay and stay visible; they simply stop being the tie-break.

---

## Deviations

### Phase 1
1. **The payload key `reviewed` became `annotated`, and that is a wire change, not wording.**
   The plan's phase 1 is "a rename, and nothing else", and listed paths, files and on-screen
   words. It did not name the response field, but the automated verification it *does* name
   ("no identifier, path or label") cannot pass while a response key says `reviewed`. So
   `GET /annotate/panels`, `/annotate/panels/:slug/next` and `/previous` now return `annotated`,
   the queue service's `reviewedWhere` is `annotatedWhere`, and `listReviewPanels` is
   `listAnnotationPanels`. No behaviour changed; nothing outside this repo reads these routes
   (they are `/internal`, console-only). `annotate.test.ts`'s key-set assertion was re-sorted
   because `annotated` sorts before `input`.
2. **r7 corrects one FACT beside the word.** The mockup's ROLE line read "also any staff member
   who opts in via *Review traces*" — a door ADR-0084 removed. Leaving it would have had the
   approved drawing re-assert a route that no longer exists, so it now reads "also any staff
   member who is ASSIGNED work and comes here deliberately". The r7 revision note says so. The
   `<title>` also still said `r5` (stale since r6); it says r7.
3. **`unreviewed` in `tokens.css` was renamed in BOTH copies.** `apps/web/src/styles/tokens.css`
   §1–§5 are verbatim from `mockups/tokens.css`, so the comment (`neutral / unannotated`) changed
   identically in each rather than in the app copy alone, which would have broken the diff
   invariant the header asks for.
4. **Design-review prose was left alone, deliberately.** "the 6b review", "reviewable as a diff",
   "its own review deleted it" are about REVIEWING ARTEFACTS, not about annotating traces, and
   ADR-0085 retires the product's noun rather than the English word. Two quoted historical labels
   also stay verbatim — `gate.tsx` and `section-nav.tsx` each record that phase 5 offered a
   **Review traces** control and that it was removed; renaming a quotation would falsify it.

### Phase 2
5. **A member who cannot annotate cannot be assigned.** Open question 5 says assignment draws
   from the org's MEMBERS rather than its annotators, and it does — an admin or engineer is
   assignable and may be the dictator. But `guest_expert` holds NOTHING until M8 (ADR-0072), so
   assigning one would write work rows they cannot reach: every annotate route is
   `annotation: ['create']`, which they lack. The service refuses them with the same 422 a
   non-member gets, phrased so the caller cannot tell which. The rule is read off the capability
   map rather than off a role list, so M8 granting guests `annotation: ['create']` makes them
   assignable with no change here.
6. **Each failure is its own union arm.** `TopUpResult` and `AssignResult` list
   `{ kind: 'not_found' }`, `{ kind: 'archived' }` … separately rather than as one arm with a
   union `kind`. TypeScript narrows the discriminant either way, but only separate arms can be
   EXCLUDED — and the route needs `unknown_traces` gone from the type after it has handled it,
   or `traceIds` is reachable where it does not exist. The same reason `notFoundSet` is annotated
   `: () => never` rather than inferred: narrowing through a throwing helper needs the type to
   say `never` at the declaration.
7. **The unique-violation check names its constraint.** `isUniqueViolation` reads the SQLSTATE
   off `error.cause.code` as well as `error.code` (Drizzle wraps the driver error — the trap
   `annotate.test.ts` already documents) AND requires `annotation_sets_panel_name_key`. Without
   the name, a unique index added later would be reported to a caller as "that name is taken".
8. **The manual check ran on `demo`/`brixadi-brand-taste`, not `testing`/`support-chat`.** The
   plan named the panel; the `testing` org's admin on this machine is a GitHub-verified account
   with no password to `curl` with, and `brixadi-brand-taste` (51 traces, seed admin) exercises
   the same paths. The set it created is left in the dev database on purpose — phases 3 and 4
   need one to look at.
9. **Phase 2's branch is STACKED on phase 1's**, not cut from `main`: both touch
   `routes/internal/index.ts`, and #96 is still open. The PR's base is
   `refactor/m5-p7-annotation-vocabulary` and GitHub retargets it to `main` when that merges.

### Phase 3
10. **The queue's list is `listAssignedSets`, not `listAnnotationSets`.** The plan names it
    `listAnnotationSets`, but phase 2 already exports that from `services/annotation-sets.ts` for
    the staff read — two same-named exports meaning "a panel's sets" and "my sets" is exactly the
    ambiguity a name should close. The queue's says whose sets it returns.
11. **The write takes the set in the PATH**, `POST /annotate/sets/:id/annotations`, rather than a
    `set_id` in the body. The plan says "the write takes the set id" without saying where; the
    path matches the reads beside it, and it leaves the BODY's key set exactly as ADR-0067's
    tests assert it (`item_id`, `outcome`, `note` — nothing added).
12. **`countingAnswer` returns `null` when the answers differ and the dictator has not answered.**
    The plan says the dictator's counts where answers differ; it does not say what to report
    before they have spoken. Reporting somebody else's would invent a decision nobody made, so
    the honest answer is "no tie-break yet". It is a pure function over rows — the staff read and
    the trace detail must not compute this two different ways — and phase 4 consumes it.
13. **`setProgress` carries TWO counts per annotator, and only one of them decides done.**
    `answered` includes skips, because a skip empties that trace out of your queue; `annotated`
    excludes them, because a skip is an answer we store and not an annotation, and counting it
    would let somebody run their counter up by pressing S. Done reads `answered`, so "done" and
    "nothing left in anybody's queue" cannot drift apart.
14. **A set with NO TRACES or NOBODY ASSIGNED is explicitly not done.** Both are vacuously true
    under "every assigned annotator has answered every trace", and both mean a pass that has not
    happened. ADR-0086 does not say so; the code and a test now do.
15. **An ARCHIVED set is not offered to its annotators.** It stays readable to staff behind the
    filter (phase 4), but it has been put away, so it leaves the annotator's list and its queue
    answers NOT_FOUND like any other unreachable set. The plan says archiving is a stamp and does
    not change done; it did not say what it does to the queue.
16. **Keyboard note, not a defect:** the browser pane's synthetic key events do not reach the
    page's `window` keydown listener, so Y/N/S and Enter looked dead when driven from the harness.
    Dispatching a real `KeyboardEvent` in the page selects and saves correctly, so r6 decision 8
    still holds — the shortcut path is intact and the tooling was the problem.

### Phase 4
17. **The set LIST carries `done` too, from the same `setProgress`.** The plan puts "how many
    traces are answered" on the list and `setProgress` in phase 3; the list route now calls it
    once for the whole page rather than per row. One definition, asked once.
18. **`countingAnswer` is computed on the SERVER and sent with each trace row.** The plan says
    the dictator's is "marked"; doing that marking in the console would be a second
    implementation of ADR-0081's read rule, and M6 will read the same rows from SQL. The grid
    renders what the server decided.
19. **`PUT` was missing from the console's CORS allow-list, and only a browser could say so.**
    `PUT /annotation-sets/:id/annotators` (phase 2) is the first PUT this API ever registered.
    The preflight is answered 204 whatever the method is, and the browser then drops the real
    request on its own with no server-side trace — so the whole suite was green while the assign
    dialog silently did nothing. `index.ts` already carried a comment predicting exactly this
    ("the one line in M4's tenancy work that no test can catch — `app.request()` sends no
    preflight"). **It is now catchable and caught**: `routes/internal/cors.test.ts` asks the app
    for every method its router registers and asserts the preflight allows each one. Verified to
    fail with the method removed, and to name it.
20. **A section's sidebar row is `gated` OR live, not both.** The row carried a milestone mark
    above the floor as well as a padlock below it, because the section did not exist yet. It
    does now, so `gated` means the floor alone and the row is an ordinary link above it.
21. **No `bun test apps/web` was added.** The plan suggests pure web tests for "state derivation
    for the badge" and "the create form's rules" — neither is a pure function here. The badge
    reads `done` straight off the server (Deviation 17) rather than deriving anything, and the
    form's rules are `DISPLAY_NAME_RULES` and `ANNOTATION_SET_MAX_SIZE` from contracts, already
    tested where they live. Testing either in the console would be asserting that a value is
    passed through. What the two-surface rule needed instead is a test, and it got one.
22. **The trace-table selection is component state, not the URL** — alone among this console's
    view state. It can be 250 ids, which is not what a query string is for, and a selection is a
    moment's work rather than a view somebody shares.
