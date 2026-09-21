# ADR-0079: Annotation runs against an assigned review set, and only that

**Status:** Accepted · **Date:** 2026-09-20 · **Milestone:** M5 (phase 7)
**Supersedes the queue scope of:** ADR-0066

## Decision
An annotator's work is the review SETS assigned to them. There is no panel-wide queue, no default
set, and no work that appears because a gate opened: a developer creates a set from a panel's
traces and assigns one or more annotators to it, and until that happens an annotator has nothing
to review. A set they are not assigned to answers NOT_FOUND, exactly as another org's does.

## Context
The M5 queue served a random unanswered trace from the whole panel. At 82 traces that is
"annotate everything"; at 10,000 it is meaningless, and nothing can say what a pass covered or
when it is finished. A set is a bounded unit of work that can be COMPLETED, and assignment is what
makes "somebody decided this was worth your afternoon" a true claim rather than a side effect of
traffic. The accepted cost: a panel nobody curates is a panel nobody annotates.

Plan: `thoughts/shared/plans/approved/2026-09-20_review-sets.md` (decisions 3, 4)
