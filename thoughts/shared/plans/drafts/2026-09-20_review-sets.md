---
date: 2026-09-20T16:00:00Z
author: claude-code
status: draft
milestone: M5 (phase 7, after "Seeing the annotations")
topic: review-sets
related_adrs: [0003, 0019, 0061, 0064, 0066, 0067, 0073, 0077]
research: thoughts/shared/research/2026-09-20_engineer-curated-review-sets.md
---

# Review sets: annotation runs against a curated set, not the whole panel

## Goal
An engineer creates a **review set** — a named, snapshotted selection of a panel's traces, picked
manually or by **latest N / earliest N / random N** — **assigns reviewers to it**, and those
reviewers work that set. **An annotator has nothing to review until a set is assigned to them**
(stakeholder, 2026-09-20): no default set, no panel-wide queue, no work that appeared because a
gate opened. **Several reviewers may share one set.** Sets can be **topped up** by running a
picker again, which appends; membership is append-only and timestamped, so a set grows without
ever losing what it held when a given annotation was made.

**Milestone: M5, phase 7.** BUILD_SPINE M5 names "sampling queues: random, low-confidence" as
this milestone's work; manual/latest/earliest/random need only traces, where low-confidence and
judge-disagreement need judges and are M6's. It lands after phase 6, whose staff read is what
makes a set's progress visible. **Several reviewers on one set are in this plan; OVERLAP — the same
trace answered twice on purpose, with an arbiter to settle a split — is the open question below.**
BUILD_SPINE M5 lists "multi-annotator consensus" under *Not now*, and the vocabulary overlap needs
(arbiter, overlap, split, alignment session) is still absent from PRODUCT.md 5.5, which the Phase
A harvest §5 recorded in August and which is a human writing act, not a coding one.

---

## Phase 1 — The set, its membership, and the pickers

### Changes
- `packages/db/migrations/0016_review_sets.sql` + `schema/review-sets.ts`:
  - `review_sets`: `id (rvs_)`, `org_id`, `panel_id`, `name`, `created_by` (→ `user`, RESTRICT,
    as `authored.ts` does), `completed_at` (nullable), `created_at`.
    UNIQUE `(panel_id, lower(name))` — two sets called "Launch week" in one panel is a mistake,
    not a choice. **No membership column and no count**: both are derivable, and a cached count
    is the thing that goes wrong silently. No `is_default` — there is no default set.
  - `review_set_reviewers`: `review_set_id`, `user_id` (→ `user`, RESTRICT — a person who
    reviewed outlives their assignment, PRODUCT §10), `assigned_by`, `assigned_at`,
    `unassigned_at` (nullable). PK `(review_set_id, user_id)`. **Assignment is what makes work
    exist**: an annotator sees the sets assigned to them and nothing else. Unassigning is a
    stamp, never a delete, so "who was asked to do this" survives (the `api_keys` posture).
  - `review_set_traces`: `review_set_id`, `trace_id`, `strategy` (enum:
    `manual | latest_n | earliest_n | random_n`), `added_at`, `added_by` (→ `user`, RESTRICT).
    PK `(review_set_id, trace_id)` — the same trace cannot be added twice, and a top-up that
    would re-pick it is a no-op rather than a duplicate. **Append-only by GRANT**, like
    `annotations` and `audit_events`: `REVOKE UPDATE, DELETE`. Removing a trace from a set after
    someone annotated it would rewrite what a past pass covered (ADR-0003's posture).
  - `rvs_` added to `ID_PREFIXES`.
- `packages/contracts/src/review-sets.ts` (new) — the strategy enum, the size bounds
  (1…`REVIEW_SET_MAX_SIZE`), the create / top-up / assign request schemas, and the name rule
  reusing `names.ts` (the shared rules M4 Deviation 56 put there).
- `packages/contracts/src/capabilities.ts` — `annotation` gains `curate`. `admin` and `engineer`
  hold it; `annotator` holds `create` only. Curating is choosing what someone's afternoon is
  spent on, which is the engineer's call, not the reviewer's.
- `apps/api/src/services/review-sets.ts` (new):
  - `resolveTraces(strategy, size, panelId, explicitIds?)` — ONE place the four pickers live.
    `latest_n`/`earliest_n` order by `(created_at, id)` as `listTraces` does; `random_n` uses
    `ORDER BY random()`; `manual` takes ids and verifies every one belongs to the panel.
  - `createReviewSet` and `topUpReviewSet` — both resolve, then INSERT membership with
    `ON CONFLICT DO NOTHING`, in one transaction with an audit event
    (`review_set.created` / `review_set.topped_up`, carrying the strategy and the count, never
    trace ids — the log is append-only and an id list would make it unbounded).
- `apps/api/src/routes/internal/review-sets.ts` (new), `annotation: ['curate']`:
  `GET /panels/:slug/review-sets`, `POST /panels/:slug/review-sets`,
  `POST /review-sets/:id/top-up`, `PUT /review-sets/:id/reviewers` (assign and unassign, against
  the org's members). Another org's panel is NOT_FOUND (ADR-0057).

### Steps
- [ ] Migration 0016, schema (sets, membership, reviewers), grants, `rvs_` prefix
- [ ] Contracts: strategies, sizes, name rule, `annotation: ['curate']`
- [ ] `resolveTraces` and the two writes, each with its audit event
- [ ] Routes, with the role × route matrix rows, including assignment
- [ ] Tests: each picker returns what it says (latest/earliest by `created_at`, random within the
      panel, manual refusing a trace from another panel); membership is append-only by grant
      (SQLSTATE 42501); a top-up that re-picks an existing trace adds nothing; a duplicate name in
      one panel is a 422; the audit event carries the strategy and no trace ids; assigning and
      unassigning a reviewer is audited, and unassigning keeps the row

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] Create a set of random 25 on `support-chat` by `curl`; `psql` shows 25 membership rows with
      the strategy on them; top it up by 25 and see 50 rows, the new ones with a later `added_at`

---

## Phase 2 — The queue serves an ASSIGNED set

### Changes
- `apps/api/src/services/annotation-queue.ts` — the pool becomes membership:
  `answerableWhere` is unchanged (both rules still hold), but the FROM becomes
  `review_set_traces JOIN traces`. `nextItem(setId, annotatorId)` replaces
  `nextItem(panelSlug, …)`; `previousItem` scopes to the set; `listReviewPanels` becomes
  `listReviewSets` — **the sets ASSIGNED to this person**, with size, reviewed and remaining.
  A set they are not assigned to is NOT_FOUND, exactly as another org's is: being told "that
  exists but is not yours" is information nobody needs.
- **No default set and no bootstrap path.** An annotator with no assignment sees an empty state
  that names the act rather than the absence — "nothing assigned yet" — and the surface offers
  nothing to press. Work exists because someone chose to give it, which is the whole point of
  assignment.
- `packages/db/.../annotations.ts` + migration — `review_set_id` (nullable, → `review_sets`,
  RESTRICT). Nullable ONLY for the rows written before this phase; every new row carries the set
  it was answered from, which is what makes "what did this pass find" answerable later.
  `annotations.sampler` now carries the membership row's `strategy` rather than the constant
  `'random'` — the column has existed since M5 phase 4 for exactly this.
- `apps/api/src/routes/internal/review.ts` — `/review/sets`, `/review/sets/:id/next`,
  `/review/sets/:id/previous`; `POST /review/annotations` takes the set id with the item.
  Payload absences are unchanged (ADR-0067, ADR-0077); the set's NAME reaches the annotator, its
  strategy does not.
- `apps/api/src/services/annotation-queue.ts` — `completed_at` is stamped when a set's last
  answerable trace is answered (the write already knows the remaining count).

### Steps
- [ ] Queue pool from membership; `listReviewSets`; next/previous by set
- [ ] Sets scoped to this person's assignments; an unassigned set is NOT_FOUND
- [ ] `annotations.review_set_id` + `sampler` from the membership row
- [ ] Review routes moved to sets; the old panel routes removed
- [ ] Tests: a set's queue never serves a trace outside it; an unassigned set is NOT_FOUND for
      the annotator and readable for staff; two reviewers on one set never receive the same trace
      (the divide rule, until overlap exists); the floor still refuses; `sampler` records the
      picker; a set completes when its last trace is answered

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] As an annotator with nothing assigned: the surface says so and offers nothing. Assign a set
      as an engineer, reload, and it appears; annotations carry its id

---

## Phase 3 — The console creates sets; the annotator picks one

### Changes
- `apps/web/src/routes/traces.tsx` — row checkboxes and a **New review set** action (manual
  selection reuses the table an engineer is already reading, rather than a second browser).
- `apps/web/src/routes/review-sets.tsx` (new) — the panel's **Review sets** section: each set
  with its size, how much is answered, **its reviewers**, **Assign reviewers** (the org's members,
  as `members.tsx` lists them) and **Top up**. Replaces the sidebar's Review traces link target
  for staff.
- `apps/web/src/routes/review.tsx` — the annotator's landing lists SETS (name, remaining,
  reviewed), grouped by panel.
- `apps/web/src/routes/review-session.tsx` — addressed by set: `/review/$setId`.
- `apps/web/src/components/shell/section-nav.tsx` — **Review sets** for staff (locked below the
  floor as today), keeping **Review traces** as the annotator's own entry.
- Create dialog: name, strategy, size — with the count it will take shown before it runs.

### Steps
- [ ] Trace-table selection and the create dialog
- [ ] Review sets section, with assignment and top-up
- [ ] Annotator landing and session moved to sets
- [ ] `bun test apps/web` covers the pure parts (the size/strategy form rules)

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`

### Manual verification
- [ ] As an engineer: select six traces by hand, make a set, annotate it as yourself, see it
      complete; make a random 50 set and top it up
- [ ] As an annotator: only assigned sets are listed, with their counts, and the session never
      shows which strategy chose the trace; with nothing assigned the surface says so

---

## Decisions made
1. **Membership is a snapshot, resolved once per picker run** — over a saved query that
   re-evaluates: what an annotation was part of must not change under it (ADR-0003).
2. **Membership is append-only by GRANT, and timestamped** — over allowing removal: this is what
   makes top-up safe, because "what the set held when this annotation happened" stays a query.
   Same treatment as `annotations` and `audit_events`.
3. **Annotation is set-only** — over keeping the panel-wide queue beside it: two ways to answer
   the same trace would make "what did this pass cover" unanswerable, which is the problem.
4. **Work exists only when ASSIGNED** (stakeholder, 2026-09-20) — over the default set this plan
   carried an hour ago, and over any bootstrap that manufactures work from a gate opening. An
   annotator's queue is the sets given to them; "somebody decided this was worth your afternoon"
   is the claim the surface should be making, and a set that appeared on its own makes it falsely.
   The cost is real and accepted: a panel nobody curates is a panel nobody annotates.
5. **Several reviewers may share one set** — assignment is many-to-many from the first migration,
   because "add another pair of eyes" is the request that arrives immediately. Until overlap
   exists they DIVIDE the set (ADR-0066's rule: one person per trace); overlap makes them
   duplicate it deliberately, which is decision 11.
6. **The 50-trace floor stays on the panel** — over moving it to the set, which would let a
   10-trace set route around ADR-0061.
7. **`rvs_`, not `ds_`** — `ds_` is reserved for datasets (CONVENTIONS): a set is what annotation
   runs against, a dataset is what training consumes, and M6/M7 will need both names.
8. **`annotations.review_set_id`, and `sampler` carries the picker** — over inferring either from
   membership later: which strategy found the failures is the question the `sampler` column was
   added for in phase 4.
9. **Curating and ASSIGNING are `annotation: ['curate']`, held by admin and engineer** — over letting an
   annotator curate: choosing what someone's afternoon is spent on is not the same act as
   spending it.
10. **The set's name reaches the annotator; its strategy does not** — ADR-0067's reasoning applied
   to selection: naming the picker would leak what M6's samplers exist to hide.
11. **OVERLAP and the arbiter are the open question below, not a settled deferral.** Sharing a
    set is in this plan; the same trace being answered TWICE deliberately is not, yet. It changes
    what "answered" means (today: anybody has), adds a resolution object, and needs the arbiter /
    overlap / split vocabulary PRODUCT.md 5.5 still lacks — a human writing act, recorded in the
    Phase A harvest §5 since August. BUILD_SPINE M5 lists multi-annotator consensus under
    *Not now*, so promoting it is a spine edit as well.

## Explicitly NOT doing
- **Overlap, arbiter, split verdicts, alignment sessions** — deferred (decision 10). PRODUCT.md
  5.5 must gain the vocabulary first; that is a human writing act.
- **Low-confidence and judge-disagreement pickers** — they need judges (M6).
- **Honeypots** — gold-standard traces with known answers are a different object (PRODUCT 5.5).
- **Sets spanning panels** — a set belongs to one panel; a cross-panel pass is M6's taxonomy work.
- **Removing traces from a set** — append-only by grant, deliberately.
- **Sharing a set between orgs, or assigning it to named people** — assignment arrives with
  overlap.

## Open questions for the human
1. **Does OVERLAP land here or after PRODUCT.md 5.5 is written?** Two shapes:
   (a) **share-and-divide now** — several reviewers, each trace answered once, no arbiter, no
   splits: the smallest change that honours "more than one annotator can annotate a set", and it
   ships with this plan;
   (b) **overlap now** — a per-set number ("every trace gets 2 answers"), a split when they
   disagree, and a designated arbiter who resolves it. That needs the 5.5 vocabulary first,
   carries a resolution object, and is where inter-annotator agreement (M6's metric) starts.
   The plan as written is (a). Say the word and I will fold (b) into it as phase 4 — but the
   PRODUCT.md paragraph is yours to write either way.
2. **`REVIEW_SET_MAX_SIZE`** — a cap on one set. 500? 1,000? A set of 10,000 is not a pass anyone
   finishes, and the number belongs in contracts where both sides read it.
3. **Manual selection across pages** — the trace table is keyset-paginated; does selection
   survive paging (state in the URL), or is one page the practical limit for a first cut?
4. **Does a set's completion need every trace answered**, or is "no answerable traces left for
   anyone" enough? They differ once a trace is skipped by every reviewer assigned to it.
6. **Can a person be assigned a set in a panel they otherwise cannot see?** Membership is
   org-wide today (the panel-scoping deferral of 2026-09-18), so assignment is currently the only
   thing narrowing an annotator to a panel — which is either a happy accident or the panel-scoped
   access that deferral described, arriving early.
5. **Should an engineer see a set's ANNOTATIONS from the set screen** (phase 6 shows them per
   trace), or is that M6's taxonomy surface?
