# ADR-0086: An annotation set is done by derivation and archived by a person

**Status:** Accepted · **Date:** 2026-09-21 · **Milestone:** M5 (phase 7)

## Decision
**Done is computed, never stored**: an annotation set is done when every **currently assigned**
annotator has answered every trace in it. There is no `completed_at`.

"Currently assigned" is `unassigned_at IS NULL`, and the word is load-bearing (stakeholder,
2026-09-21). Unassigning is a stamp rather than a delete, so a person who was unassigned keeps
their rows and keeps them visible — but the set stops waiting on them. Read as "every assigned
annotator", one unassigned person would block a set from ever completing, which is the opposite
of what unassigning is for.

**Archived is a stamp a person sets**: one nullable `archived_at`, written by a developer putting
a finished — or abandoned — pass away.

The two are independent. A set can be done and not archived, which is the normal state of a pass
somebody has just finished and not yet filed; it can be archived and not done, which is how an
abandoned pass is retired.

One function owns the derivation (`setProgress`), used by the annotator's set list and by the
staff Annotations section (ADR-0084). **One definition of done, or the two screens will disagree.**

## Context
The superseded plan stamped `completed_at` when a set's last answerable trace was answered. That
is wrong the moment a third annotator is assigned to a finished set: the set genuinely is not done
any more — someone has work to do in it — and a stored flag would go on saying it was. Assignment
is a live relation (ADR-0079), so anything derived from it has to be derived when read.

A cached count is the thing that goes wrong silently, which is the same reasoning that keeps a
membership count off `annotation_sets` in the first place.

Archiving cannot be derived, because it is not a fact about the data — it is somebody deciding
they are finished looking at it. So it is the one lifecycle column, and it records an act rather
than a state.

Plan: `thoughts/shared/plans/approved/2026-09-21_annotation-sets.md` (decision 3)
