---
date: 2026-09-20T15:00:00Z
author: claude-code
status: draft
milestone: M5 (candidate phase 7) or M6
topic: engineer-curated-review-sets
related_adrs: [0003, 0019, 0061, 0066, 0067, 0073, 0077]
---

# Engineer-curated review sets

## Problem
The queue serves a random unanswered trace from the WHOLE panel (`annotation-queue.ts`,
ADR-0066). At 82 traces that is the same thing as "annotate everything"; at 10,000 it is
meaningless — an annotator's attention is the expensive input, and nobody can say what was
covered or when a pass is finished. The stakeholder's shape (2026-09-20): an engineer creates a
review set, choosing traces **manually, latest N, earliest N or random N**, and the annotator
works that set instead of the panel. It also gives M5 something it lacks — a bounded unit of
work that can be **completed** rather than an infinite stream.

## Relevant files and why each matters
- `apps/api/src/services/annotation-queue.ts` — the queue. `answerableWhere` (the two rules),
  `nextItem` (random pick, floor gate), `listReviewPanels`, `previousItem`, `recordAnnotation`.
  A set changes WHAT the pool is; the two rules and the floor are orthogonal to it.
- `apps/api/src/routes/internal/review.ts` — `/review/panels`, `…/:slug/next`, `…/:slug/previous`,
  `POST /review/annotations`. All `annotation: [create]`; the payload's ABSENCES are the design.
- `packages/db/src/schema/annotations.ts` — `ann_` rows, append-only by grant, `sampler` column
  **already recorded on every row** ('random' today). A set's strategy is what that column is for.
- `packages/db/src/schema/traces.ts` — what a set selects from: `created_at` (ordering for
  latest/earliest N), `panel_id`, `input`/`output`/`reference` (ADR-0073).
- `apps/api/src/repositories/traces.ts` — `listTraces` already does KEYSET pagination over
  `(created_at, id)` for the console's trace table: the same ordering a "latest N" would take,
  and the screen an engineer would select from by hand.
- `apps/web/src/routes/review.tsx`, `review-session.tsx` — the annotator's two screens; the
  landing lists PANELS today and would list SETS (or panels with their open set).
- `apps/web/src/routes/traces.tsx` + `components/shell/trace-drawer.tsx` — the console's trace
  list and detail; manual selection belongs here (checkboxes on the rows already being read).
- `packages/contracts/src/annotations.ts` — `ANNOTATION_FLOOR`, outcomes, note rules. A set's
  size and strategy vocabulary would join it, since both sides read them.
- `packages/contracts/src/ids.ts` — `ID_PREFIXES`. **`ds_` is already reserved** for datasets
  (CONVENTIONS "API rules"); a review set is NOT that (see constraints) and needs its own.
- `apps/api/src/middleware/require-permission.ts` + `packages/contracts/src/capabilities.ts` —
  the capability map. Creating a set is an ENGINEER act; working one is an annotator act. The
  map has `annotation: ['create']` only, so a new action (`annotation: ['curate']`?) is needed.

## Constraints and patterns that apply
- **CONVENTIONS, "Data rules":** *"Dataset membership is a versioned join table — never a
  boolean on the annotation."* A review set is membership by another name; the same rule should
  hold, and it rules out marking traces "in review" in place.
- **ADR-0003 (immutable versions):** anything a past annotation was judged under must be
  reconstructible. If a set can gain or lose traces after annotations exist, the plan must say
  what an annotation points at — most likely the set is append-only membership, or versioned.
- **ADR-0061 / `ANNOTATION_FLOOR`:** annotation unlocks at 50 collected traces. A set smaller
  than 50 would let someone route around the gate; the plan must decide whether the floor
  applies to the PANEL (probably) or to the set.
- **ADR-0066:** the queue is per-panel, random, one person per trace, skip frees it. A set
  replaces "per-panel" only; the other three rules are untouched. The `sampler` column exists
  precisely so "which strategy found the failures" stays answerable — a set's strategy must be
  written there rather than invented later.
- **ADR-0067 / ADR-0077:** the annotator payload withholds operator signals and `metadata`. A
  set's NAME reaches the annotator; its selection strategy probably should not (naming
  "low-confidence" would leak what M6's samplers deliberately hide).
- **ADR-0019 / PRODUCT 5.5:** sampling strategies (random, low-confidence, judge-disagreement,
  honeypots) are a named product feature, and `docs/SENIORITY_CHECKLIST.md` line 20 puts
  "Annotation UI + sampling strategies" in **M5** with a demo clip. This work is the mechanism
  those later samplers plug into: the same set, a different picker.
- **M6 owns the samplers that need judges** (BUILD_SPINE M6: judge-disagreement sampling).
  Manual/latest/earliest/random need nothing but traces, which is why they can land in M5.
- **Queue SQL trap, already paid for:** a Drizzle column inside a `sql` template renders
  unqualified (Deviation 19 of the M5 plan; Deviation 60 of M4's). Any correlated subquery a set
  adds must qualify by hand.
- **`docs/PARKING_LOT.md` "Bulk seed upload"** is the same user in the other direction: they have
  history and want a gate sooner. A set is what they would then point an annotator at, and the
  two together are "a team can start on Monday".

## Decisions taken (stakeholder, 2026-09-20)

1. **Membership is a SNAPSHOT at creation.** "Latest 200" resolves once and the rows are
   written; the set does not re-evaluate. ADR-0003's posture, and what makes "this pass covered
   these traces" reconstructible a year later.
2. **Annotation becomes SET-ONLY.** The whole-panel queue stops being the unit of work — an
   annotator works a set or there is nothing to work. Consequence to plan for: **every panel
   that is annotated today needs a set**, and phases 4–5 as shipped serve from the panel, so
   this is a replacement of that path rather than an addition beside it.
3. **A set may have SEVERAL reviewers, with a designated tie-breaker.** This is the **arbiter**
   the Phase A mockups already proposed — `thoughts/shared/research/2026-08-20_phase-a-design-harvest.md`
   §5 records that the screens cite "PRODUCT.md 5.5" for an arbiter role, an **overlap** setting
   (how many annotators per trace), **split** verdicts and an **alignment session**, and that
   **5.5 contains none of them**. That gap is now on the critical path: the vocabulary has to be
   written into PRODUCT.md before it is built, which is a human act.
4. **A panel gets a DEFAULT SET automatically** (stakeholder, 2026-09-20), named as such and
   renameable, so "set-only" costs nothing at onboarding: an annotator arriving at a freshly
   gated panel has something to work, and the two panels already being annotated keep working
   without anyone curating. Engineers then build named sets beside it. **What this makes safe is
   TOP-UP** (see the recommendation): membership append-only and timestamped means a set can gain
   traces later and "what it held when this annotation happened" is still answerable — which is
   the versioned join table CONVENTIONS asks for, and the difference between growing a set and
   the saved query that was rejected.
5. **The 50-trace floor stays on the PANEL.** A set cannot route around ADR-0061; a small set
   inside a gated panel is fine, a set inside an ungated one is not.

## Open questions for the human

Answered above: snapshot, set-only, multi-reviewer with an arbiter, floor on the panel. What
those answers RAISE:

1. **When is the default set created, and from which picker?** At the gate (50 traces) it can
   only hold 50, and a snapshot never grows — so traces 51+ would sit in no set until someone
   curated or topped it up. Options: create it at the gate and top it up explicitly; create it
   lazily when an annotator first arrives (snapshotting up to N then); or make the default the one
   set that tops itself up. **Recommendation: RANDOM 100, not the first 100** — ADR-0066 chose
   random serving because a solid block of one week's traffic is the worst sample to build a
   taxonomy from, and "the first 100" reintroduces exactly that at the selection layer, where it
   is harder to see. The convenience is identical.
2. **Overlap is a number, and somebody sets it.** Is it per set ("every trace in this set gets 2
   answers"), or per trace? The harvest's mockups put it at assignment time, with a bulk "send to
   annotation queue" action setting it (§6a, Q4 there).
3. **Who may be the arbiter?** The harvest asks whether the role needs restricted console access
   (its Q5, recorded as possibly paranoia). A dictator who is also an annotator on the same set is
   a different claim from one who only adjudicates.
4. **When does adjudication happen** — as splits arise, or after the set is complete? The
   mockups' alignment session is a discrete, reviewed-first object; M6 owns alignment sessions,
   so the plan must say which half of this lands in M5.
5. **What does an arbiter SEE?** ADR-0067 withholds operator signals from an annotator; an
   arbiter necessarily sees both annotators' answers and notes, which is a different payload and
   deserves its own decision rather than inheriting either surface's.
6. **Does the set carry the overlap and arbiter, or does the PANEL?** A per-set choice is more
   flexible; a per-panel default is fewer decisions per set.
7. **ANSWERED by the default set**: the two panels already being annotated get one on migration.
   Still to say: does a panel below the floor get one too (dormant until the gate opens), and does
   a set that is `completed` stop a default from being made again?
7. **Is "completed" a state on the set**, and does it require every trace answered by the full
   overlap, arbitration included?
8. **`ds_` is reserved for datasets** (CONVENTIONS). A review set is not a dataset — it is what
   annotation runs against, where a dataset is what training consumes — so it needs its own
   prefix. `rvs_`? And does an M6 dataset then reference a set, or the annotations directly?

## Recommended approach (input to planning, not the plan)
- **Membership is APPEND-ONLY and timestamped**, which is what lets a set be topped up without
  giving up the snapshot: the picker resolves once per run, never removes, and "the set as of
  this annotation" is a query rather than a lost fact. A saved query that silently re-evaluates
  stays rejected; an engineer pressing "add 100 more" is a different act with a row to show for it.
- **A new table, `review_sets` (`rvs_`), plus an append-only membership join** — following the
  dataset rule rather than a flag on the trace. The set stores its `strategy` and `size` as
  written; membership stores the traces the strategy resolved to, at creation.
- **The strategy is a PICKER over the panel's traces**, run once: `manual`, `latest_n`,
  `earliest_n`, `random_n`. Each writes the same membership rows, and the strategy name is what
  `annotations.sampler` records for work done from that set — so the column that already exists
  starts carrying real information.
- **The queue's change is one predicate**: the pool becomes "traces in this set" instead of
  "traces in this panel". `answerableWhere`, the floor and the skip rule are untouched, which
  keeps ADR-0066 intact and the diff small.
- **Manual selection reuses the console's trace table** (`listTraces`, already keyset-paginated)
  with row checkboxes and a "New review set" action — no second browsing surface.
- **Multi-reviewer is a SECOND layer, and probably a second phase.** Sets with one reviewer each
  is the same queue with a different pool; overlap + an arbiter changes what "answered" means
  (the queue's rule 2 today is "anybody answered it"), adds a resolution object, and needs the
  PRODUCT.md 5.5 vocabulary written first. Planning them as one phase would couple a small change
  to an unwritten product concept.
- **Land the set itself as M5 phase 7**, after phase 6 (staff seeing annotations), because phase
  6's read is what makes a set's progress visible; M6 then adds its judge-backed pickers to the
  same seam, and the arbiter arrives with — or just before — M6's alignment sessions.
- **Do not** build low-confidence or disagreement pickers here (they need judges — M6), and do not
  let a set bypass the 50-trace gate.
