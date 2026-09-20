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
manually or by **latest N / earliest N / random N** — and the annotator queue serves from that set
instead of from the whole panel. A panel with no set gets a **default set of random 100, made
lazily** when an annotator first arrives, so set-only annotation costs nothing at onboarding. Sets
can be **topped up** by running a picker again, which appends; membership is append-only and
timestamped, so a set grows without ever losing what it held when a given annotation was made.

**Milestone: M5, phase 7.** BUILD_SPINE M5 names "sampling queues: random, low-confidence" as
this milestone's work; manual/latest/earliest/random need only traces, where low-confidence and
judge-disagreement need judges and are M6's. It lands after phase 6, whose staff read is what
makes a set's progress visible. **Multi-reviewer overlap and the arbiter are NOT in this plan** —
BUILD_SPINE M5 lists "multi-annotator consensus" under *Not now*, and the vocabulary they need
(arbiter, overlap, split, alignment session) is still absent from PRODUCT.md 5.5, which the Phase
A harvest §5 recorded in August and which is a human writing act, not a coding one.

---

## Phase 1 — The set, its membership, and the pickers

### Changes
- `packages/db/migrations/0016_review_sets.sql` + `schema/review-sets.ts`:
  - `review_sets`: `id (rvs_)`, `org_id`, `panel_id`, `name`, `created_by` (→ `user`, RESTRICT,
    as `authored.ts` does), `is_default` (bool), `completed_at` (nullable), `created_at`.
    UNIQUE `(panel_id, lower(name))` — two sets called "Launch week" in one panel is a mistake,
    not a choice. **No membership column and no count**: both are derivable, and a cached count
    is the thing that goes wrong silently.
  - `review_set_traces`: `review_set_id`, `trace_id`, `strategy` (enum:
    `manual | latest_n | earliest_n | random_n`), `added_at`, `added_by` (→ `user`, RESTRICT).
    PK `(review_set_id, trace_id)` — the same trace cannot be added twice, and a top-up that
    would re-pick it is a no-op rather than a duplicate. **Append-only by GRANT**, like
    `annotations` and `audit_events`: `REVOKE UPDATE, DELETE`. Removing a trace from a set after
    someone annotated it would rewrite what a past pass covered (ADR-0003's posture).
  - `rvs_` added to `ID_PREFIXES`.
- `packages/contracts/src/review-sets.ts` (new) — the strategy enum, `REVIEW_SET_DEFAULT_SIZE`
  (100) and the size bounds (1…`REVIEW_SET_MAX_SIZE`), the create/top-up request schemas, and the
  name rule reusing `names.ts` (the shared rules M4 Deviation 56 put there).
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
  `POST /review-sets/:id/top-up`. Another org's panel is NOT_FOUND (ADR-0057).

### Steps
- [ ] Migration 0016, schema, grants, `rvs_` prefix
- [ ] Contracts: strategies, sizes, name rule, `annotation: ['curate']`
- [ ] `resolveTraces` and the two writes, each with its audit event
- [ ] Routes, with the role × route matrix row
- [ ] Tests: each picker returns what it says (latest/earliest by `created_at`, random within the
      panel, manual refusing a trace from another panel); membership is append-only by grant
      (SQLSTATE 42501); a top-up that re-picks an existing trace adds nothing; a duplicate name in
      one panel is a 422; the audit event carries the strategy and no trace ids

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] Create a set of random 25 on `support-chat` by `curl`; `psql` shows 25 membership rows with
      the strategy on them; top it up by 25 and see 50 rows, the new ones with a later `added_at`

---

## Phase 2 — The queue serves a set, and a default set appears

### Changes
- `apps/api/src/services/annotation-queue.ts` — the pool becomes membership:
  `answerableWhere` is unchanged (both rules still hold), but the FROM becomes
  `review_set_traces JOIN traces`. `nextItem(setId, annotatorId)` replaces
  `nextItem(panelSlug, …)`; `previousItem` scopes to the set; `listReviewPanels` becomes
  `listReviewSets` — every set in the org with its size, how many this person has reviewed, and
  how many remain for them.
- **The default set, lazily** — in the same service: an annotator asking for a gated panel with
  NO set gets one created (`random_n`, `REVIEW_SET_DEFAULT_SIZE`, `is_default`, named
  "Default set"), in a transaction, and is then served from it. Below the floor nothing is
  created, so panels nobody annotates accumulate nothing. Created under an advisory lock on the
  panel, because two annotators arriving at once must not make two default sets.
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
- [ ] Default set, lazily, under an advisory lock
- [ ] `annotations.review_set_id` + `sampler` from the membership row
- [ ] Review routes moved to sets; the old panel routes removed
- [ ] Tests: a set's queue never serves a trace outside it; two annotators arriving together get
      ONE default set; a panel below the floor gets none; the floor still refuses; `sampler`
      records the picker; a set completes when its last trace is answered

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] Open a gated panel as an annotator with no set: a default set of 100 appears and serves;
      `psql` shows `is_default` and 100 membership rows, and the annotations carry the set id

---

## Phase 3 — The console creates sets; the annotator picks one

### Changes
- `apps/web/src/routes/traces.tsx` — row checkboxes and a **New review set** action (manual
  selection reuses the table an engineer is already reading, rather than a second browser).
- `apps/web/src/routes/review-sets.tsx` (new) — the panel's **Review sets** section: each set
  with its size, how much is answered, whether it is the default, and **Top up**. Replaces the
  sidebar's Review traces link target for staff.
- `apps/web/src/routes/review.tsx` — the annotator's landing lists SETS (name, remaining,
  reviewed), grouped by panel.
- `apps/web/src/routes/review-session.tsx` — addressed by set: `/review/$setId`.
- `apps/web/src/components/shell/section-nav.tsx` — **Review sets** for staff (locked below the
  floor as today), keeping **Review traces** as the annotator's own entry.
- Create dialog: name, strategy, size — with the count it will take shown before it runs.

### Steps
- [ ] Trace-table selection and the create dialog
- [ ] Review sets section, with top-up
- [ ] Annotator landing and session moved to sets
- [ ] `bun test apps/web` covers the pure parts (the size/strategy form rules)

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`

### Manual verification
- [ ] As an engineer: select six traces by hand, make a set, annotate it as yourself, see it
      complete; make a random 50 set and top it up
- [ ] As an annotator: the landing lists sets by name with their counts, and the session never
      shows which strategy chose the trace

---

## Decisions made
1. **Membership is a snapshot, resolved once per picker run** — over a saved query that
   re-evaluates: what an annotation was part of must not change under it (ADR-0003).
2. **Membership is append-only by GRANT, and timestamped** — over allowing removal: this is what
   makes top-up safe, because "what the set held when this annotation happened" stays a query.
   Same treatment as `annotations` and `audit_events`.
3. **Annotation is set-only** — over keeping the panel-wide queue beside it: two ways to answer
   the same trace would make "what did this pass cover" unanswerable, which is the problem.
4. **A default set of random 100, created lazily** — over the first 100 (ADR-0066's own argument:
   a solid block of one week's traffic is the worst sample for a taxonomy), over eager creation at
   the gate (dormant sets for panels nobody annotates), and over requiring curation before anyone
   can annotate (set-only would then break onboarding).
5. **The 50-trace floor stays on the panel** — over moving it to the set, which would let a
   10-trace set route around ADR-0061.
6. **`rvs_`, not `ds_`** — `ds_` is reserved for datasets (CONVENTIONS): a set is what annotation
   runs against, a dataset is what training consumes, and M6/M7 will need both names.
7. **`annotations.review_set_id`, and `sampler` carries the picker** — over inferring either from
   membership later: which strategy found the failures is the question the `sampler` column was
   added for in phase 4.
8. **Curating is `annotation: ['curate']`, held by admin and engineer** — over letting an
   annotator curate: choosing what someone's afternoon is spent on is not the same act as
   spending it.
9. **The set's name reaches the annotator; its strategy does not** — ADR-0067's reasoning applied
   to selection: naming the picker would leak what M6's samplers exist to hide.
10. **Multi-reviewer overlap and the arbiter are deferred**, with the PRODUCT.md 5.5 gap named as
    their blocker — over building them here: they change what "answered" means (today: anybody),
    and BUILD_SPINE M5 lists multi-annotator consensus under *Not now*.

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
1. **Once a default set is completed, what does the next annotator get** — a second default from
   what has arrived since, or "ask an engineer for a set"? (I lean to a second default: the
   alternative stops a running panel dead.)
2. **`REVIEW_SET_MAX_SIZE`** — a cap on one set. 500? 1,000? A set of 10,000 is not a pass anyone
   finishes, and the number belongs in contracts where both sides read it.
3. **Manual selection across pages** — the trace table is keyset-paginated; does selection
   survive paging (state in the URL), or is one page the practical limit for a first cut?
4. **Does a set's completion need every trace answered**, or is "no answerable traces left for
   anyone" enough? They differ once a trace is skipped by everyone who could see it.
5. **Should an engineer see a set's ANNOTATIONS from the set screen** (phase 6 shows them per
   trace), or is that M6's taxonomy surface?
