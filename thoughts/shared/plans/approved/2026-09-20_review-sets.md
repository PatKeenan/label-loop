---
date: 2026-09-20T16:00:00Z
author: claude-code
status: approved
approved_at: 2026-09-20T17:05:00Z
approved_by: Pat Keenan
milestone: M5 (phase 7, after "Seeing the annotations")
topic: review-sets
related_adrs: [0003, 0019, 0061, 0064, 0066, 0067, 0073, 0077, 0079, 0080, 0081, 0082, 0083]
research: thoughts/shared/research/2026-09-20_engineer-curated-review-sets.md
---

# Review sets: annotation runs against a curated set, not the whole panel

## Goal
A developer creates a **review set** — a named selection of a panel's traces, sized by them and
picked manually or by **latest N / earliest N / random N** — and **assigns one or more annotators
to it**. Each assigned annotator reviews the whole set. **If there is more than one, the developer
names one of them the DICTATOR**, whose answer is the one that counts where they disagree.
Everything else is simply recorded: every annotator's answer on every trace, overlaps included.
**An annotator has nothing to review until a set is assigned to them** — no default set, no
panel-wide queue, no work that appeared because a gate opened. Sets can be **topped up** by
running a picker again, which appends.

That is the whole feature (stakeholder, 2026-09-20). There is no overlap number to configure —
the overlap IS how many annotators were assigned. There is no split queue, no arbitration screen
and no resolution object: a disagreement is two rows and a rule for reading them.

**Milestone: M5, phase 7.** BUILD_SPINE M5 names "sampling queues: random, low-confidence" as
this milestone's work; manual/latest/earliest/random need only traces, where low-confidence and
judge-disagreement need judges and are M6's. It lands after phase 6, whose staff read is what
makes a set's progress visible. Two document lines change with it, and they are the stakeholder's:
**PRODUCT.md 5.5** gains a sentence for the set, its assignment and the dictator (its own mockups
cited 5.5 for an arbiter in August and 5.5 never had one — Phase A harvest §5), and
**BUILD_SPINE M5's "Not now: multi-annotator consensus"** becomes "recording overlaps; consensus
METRICS stay M6". Both are one-line edits, proposed in this plan and made at approval.

---

## Three tables, and which one holds what

Worth stating plainly, because "the same trace cannot be in a set twice" is about MEMBERSHIP and
reads like a limit on answers. For a 250-trace set with two annotators:

| Table | One row is | Rows |
|---|---|---|
| `review_set_traces` | this trace is IN this set | **250** — the contents, fixed at creation and grown only by top-up |
| `review_set_reviewers` | this person is assigned (one of them flagged dictator) | **2** |
| `annotations` | this person's ANSWER on this trace | **up to 500** — both annotators walk all 250 |

Both annotators see the whole set because the queue's rule is per person: a trace leaves YOUR
queue when YOU have answered it. And answers stack even for one person — the step-back correction
appends rather than edits — so the full reading rule is **latest row wins per person, and the
dictator's wins across people**.

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
    reviewed outlives their assignment, PRODUCT §10), `is_dictator` (bool), `assigned_by`,
    `assigned_at`, `unassigned_at` (nullable). PK `(review_set_id, user_id)`, plus a partial
    UNIQUE on `(review_set_id) WHERE is_dictator` — **one dictator, enforced by the database**.
    **Assignment is what makes work exist**: an annotator sees the sets assigned to them and
    nothing else. Unassigning is a stamp, never a delete, so "who was asked to do this" survives
    (the `api_keys` posture).
  - `review_set_traces`: **a join table of two ids and how the trace got there — the trace
    itself is NEVER copied.** A row is `review_set_id`, `trace_id`, `strategy` (enum:
    `manual | latest_n | earliest_n | random_n`), `added_at`, `added_by` (→ `user`, RESTRICT).
    PK `(review_set_id, trace_id)` — **the same trace cannot be in one set twice**, enforced by
    the database, and a top-up that re-picks it inserts nothing (`ON CONFLICT DO NOTHING`). The
    same trace CAN be in two different sets, which is one row each and still one trace.
    **Append-only by GRANT** (`REVOKE UPDATE, DELETE`), like `annotations` and `audit_events`:
    that is the whole of it — the app role can add a row and read it, and cannot change or remove
    one. Removing a trace from a set after somebody annotated it would rewrite what a past pass
    covered (ADR-0003's posture). Roughly 100 bytes a row: a 250-trace set is 25 KB of pointers.
  - `rvs_` added to `ID_PREFIXES`.
- `packages/contracts/src/review-sets.ts` (new) — the strategy enum, the size bounds
  (1…**`REVIEW_SET_MAX_SIZE` = 250**, stakeholder 2026-09-20: *saturation* is what bounds a pass,
  not stamina — PRODUCT 5.6 drives taxonomy size by when new traces stop producing new
  categories, and past roughly this many they have stopped), the create / top-up / assign request
  schemas, and the name rule reusing `names.ts` (the shared rules M4 Deviation 56 put there).
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
  `POST /review-sets/:id/top-up`, `PUT /review-sets/:id/reviewers` (the assigned list and which
  of them is the dictator, in one call, against the org's members). **Two or more reviewers and
  no dictator is a 422** — the developer chooses when they assign, not when a disagreement turns
  up. Another org's panel is NOT_FOUND (ADR-0057).

### Steps
- [ ] Migration 0016, schema (sets, membership, reviewers), grants, `rvs_` prefix
- [ ] Contracts: strategies, sizes, name rule, `annotation: ['curate']`
- [ ] `resolveTraces` and the two writes, each with its audit event
- [ ] Routes, with the role × route matrix rows, including assignment
- [ ] Tests: each picker returns what it says (latest/earliest by `created_at`, random within the
      panel, manual refusing a trace from another panel); membership is append-only by grant
      (SQLSTATE 42501); a top-up that re-picks an existing trace adds nothing; a duplicate name in
      one panel is a 422; the audit event carries the strategy and no trace ids; assigning and
      unassigning a reviewer is audited, and unassigning keeps the row; two reviewers with no
      dictator is refused, and a second dictator is refused by the database

### Automated verification
- [ ] `bun test`, `bun run typecheck`, `bun run lint`

### Manual verification
- [ ] Create a set of random 25 on `support-chat` by `curl`; `psql` shows 25 membership rows with
      the strategy on them; top it up by 25 and see 50 rows, the new ones with a later `added_at`

---

## Phase 2 — The queue serves an ASSIGNED set

### Changes
- `apps/api/src/services/annotation-queue.ts` — the pool becomes membership, and **rule 2
  becomes per-person**: a trace leaves YOUR queue when YOU have answered it, not when anybody
  has. That is what "everyone assigned reviews the whole set" means, and it **supersedes
  ADR-0066's "one person per trace"** — which was written when the queue was the whole panel and
  a second opinion had nowhere to live. The skip rule is untouched. The FROM becomes
  `review_set_traces JOIN traces`. `nextItem(setId, annotatorId)` replaces
  `nextItem(panelSlug, …)`; `previousItem` scopes to the set; `listReviewPanels` becomes
  `listReviewSets` — **the sets ASSIGNED to this person**, with size, reviewed and remaining.
  A set they are not assigned to is NOT_FOUND, exactly as another org's is: being told "that
  exists but is not yours" is information nobody needs.
- **No default set and no bootstrap path.** An annotator with no assignment sees an empty state
  that names the act rather than the absence — "nothing assigned yet" — and the surface offers
  nothing to press. Work exists because someone chose to give it, which is the whole point of
  assignment.
- **Reading a disagreement is a RULE, not a workflow** (`services/annotation-queue.ts`): where
  the answers on a trace differ, **the dictator's answer is the one that counts**; where there is
  no dictator there is one answer, so there is nothing to settle. Nothing is resolved by hand,
  nothing waits on anybody, and both answers stay on the table for M6 to measure agreement from.
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
      the annotator and readable for staff; **two reviewers on one set each get the whole set,
      and neither is served a trace twice**; the floor still refuses; `sampler` records the
      picker; a set completes when every assigned reviewer has answered every trace; where two
      answers differ, the dictator's is what a read returns

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
ADR stubs spawned at approval: decisions 3–4 → ADR-0079, 1–2 → 0080, 5–8 and 14, 16 → 0081,
9 → 0082, 13 → 0083. Decisions 10, 11, 12 and 15 are recorded here only — a floor that does not
move, an id prefix, a column, and where a half-made selection lives.
1. **Membership is resolved once, at creation** — over a query that re-evaluates: what a pass
   covered must not change under it (ADR-0003).
2. **Membership is append-only and timestamped** — over allowing removal, and it is what makes
   top-up safe: "what the set held when this annotation happened" stays answerable.
3. **Annotation is set-only** — over keeping the panel-wide queue beside it: two ways to answer
   the same trace makes "what did this pass cover" unanswerable, which is the problem being fixed.
4. **Work exists only when ASSIGNED** (stakeholder, 2026-09-20) — over a default set, and over
   any bootstrap that manufactures work from a gate opening. The cost is accepted: a panel nobody
   curates is a panel nobody annotates.
5. **Every assigned annotator reviews the WHOLE set; the overlap is simply how many were
   assigned** (stakeholder, 2026-09-20) — over an overlap NUMBER to configure per set. Two
   annotators on a set of 100 is 200 answers, and that is the intent rather than a setting.
6. **This SUPERSEDES ADR-0066's "one person per trace"**, which was written when the queue was
   the whole panel and a second opinion had nowhere to live. A trace now leaves YOUR queue when
   YOU have answered it. The skip rule is unchanged.
7. **The developer names a DICTATOR when there is more than one annotator, at assignment, and the
   dictator is ONE OF THEM** (stakeholder, 2026-09-20) — over resolving disagreements as a
   workflow, and over an adjudicator who does not annotate: their answer is what counts where the
   others differ, so a dictator who never answered would leave a disagreement with no winner. One
   per set, enforced by a partial unique index; two reviewers and no dictator is refused at the
   route; a dictator who is not in the assigned list is refused with them.
8. **A disagreement is read, not resolved**: where answers differ, the dictator's counts. No split
   queue, no arbitration screen, no resolution object, nothing waiting on anybody — and both
   answers stay on the table, which is what M6 measures agreement from.
9. **A set is capped at 250 traces** (stakeholder, 2026-09-20) — PRODUCT 5.6 drives taxonomy size
   by SATURATION, the point where new traces stop producing new categories; past that a pass is
   paying for attention that finds nothing new. It is also a number a person can finish, which is
   what makes "completed" mean something.
10. **The 50-trace floor stays on the panel** — over moving it to the set, which would let a
    10-trace set route around ADR-0061.
11. **`rvs_`, not `ds_`** — `ds_` is reserved for datasets (CONVENTIONS): a set is what annotation
    runs against, a dataset is what training consumes, and M6/M7 need both names.
12. **`annotations.review_set_id`, and `sampler` carries the picker** — over inferring either
    later: which strategy found the failures is the question `sampler` was added for in phase 4.
13. **Curating and assigning are `annotation: ['curate']`, held by admin and engineer** — over
    letting an annotator curate: choosing what someone's afternoon is spent on is not the same
    act as spending it.
14. **A set is COMPLETE when every assigned annotator has answered every trace in it**
    (stakeholder, 2026-09-20) — over "each trace has at least one answer", which would call a set
    done while half of one person's work is outstanding. With one annotator the two rules are the
    same; with two they differ the moment one is slower.
15. **Manual selection survives paging in MEMORY, not in the URL** — the console's trace table is
    keyset-paginated, so "tick six on this page, page back, tick four more" needs the ticks to
    outlive the page. They live in component state with a visible "10 selected · clear" control,
    and are lost on reload. The URL was the alternative and is not viable: 250 ULIDs is about
    7.5 KB, well past what a URL should carry, and `?trace=` and friends are there for state worth
    sharing — a half-made selection is not.
16. **The set's name reaches the annotator; its strategy does not** — ADR-0067's reasoning applied
    to selection. **Nor does another annotator's answer**: knowing what someone else said is the
    strongest anchor there is, and agreement measured after it is not agreement.

## Explicitly NOT doing
- **A split queue, an arbitration screen, a resolution object** — a disagreement is two rows and
  a read rule (decision 8).
- **Inter-annotator agreement as a METRIC** — this plan creates the data and stops. κ, TPR/TNR and
  the class-imbalance argument (Phase A harvest §4) are M6's, beside the judge-validation metrics
  PRODUCT 5.7 still lacks.
- **Alignment sessions** — M6's, and about a judge rather than about people.
- **Low-confidence and judge-disagreement pickers** — they need judges (M6).
- **Honeypots** — gold-standard traces with known answers are a different object (PRODUCT 5.5).
- **Sets spanning panels** — a set belongs to one panel; a cross-panel pass is M6's taxonomy work.
- **Removing traces from a set** — append-only by grant, deliberately.
- **Sharing a set between orgs** — a set belongs to one org's panel, like everything else
  (ADR-0047).

## Open questions for the human
1. **Two one-line document edits, yours at approval**: PRODUCT.md 5.5 gains the set, assignment
   and the dictator; BUILD_SPINE M5's "Not now: multi-annotator consensus" becomes "recording
   overlaps; consensus metrics stay M6".
2. **Can a person be assigned a set in a panel they otherwise cannot see?** Membership is org-wide
   (the panel-scoping deferral of 2026-09-18), so assignment is currently the only thing narrowing
   an annotator to a panel — either a happy accident or that deferral arriving early.
3. **Unassigning someone who has already answered** — drawn as: the stamp is set, their answers
   stay, and the set can no longer complete on them. Worth confirming that is what you would
   expect rather than "their answers stop counting".
