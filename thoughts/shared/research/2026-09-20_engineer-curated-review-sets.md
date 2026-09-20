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

## Open questions for the human
1. **Does a set belong to a panel, or to an org?** Per-panel is simpler and matches the queue;
   org-wide would let one set span panels (useful for a taxonomy pass over everything).
2. **Is membership frozen at creation?** "Latest 200" evaluated once (a snapshot, reconstructible)
   versus a saved query that re-evaluates (always current, but what an annotation was part of
   changes under it). ADR-0003's posture points at the snapshot.
3. **Can several annotators share a set?** Today one person per trace, panel-wide. Within a set,
   is it "divide the work" (current rule) or "everyone answers everything" (agreement data, which
   is M6's question)?
4. **What happens to traces in NO set** once sets exist — is the whole-panel queue still there as
   a default, or does annotation become set-only? (The second is cleaner; it breaks the current
   flow for a panel nobody has curated.)
5. **Does the floor move to the set?** A 50-trace panel with a 10-trace set: allowed?
6. **Who may curate — engineer and admin only, or an annotator too?** Capability map change either
   way; "an annotator curating their own work" is a different product claim.
7. **Does the annotator see the set's name and strategy, or only its name?** (ADR-0067's reasoning
   argues for name only.)
8. **Is "completed" a state?** A set that is finished is the thing that makes a pass legible —
   and it is what a taxonomy session in M6 would actually read from.

## Recommended approach (input to planning, not the plan)
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
- **Land it as M5 phase 7**, after phase 6 (staff seeing annotations), because phase 6's read is
  what makes a set's progress visible; M6 then adds its judge-backed pickers to the same seam.
- **Do not** build low-confidence or disagreement pickers here (they need judges — M6), and do not
  let a set bypass the 50-trace gate.
