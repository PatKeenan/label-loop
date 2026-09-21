# ADR-0084: Staff inspect annotations on a surface of their own, and cannot edit them

**Status:** Accepted · **Date:** 2026-09-21 · **Milestone:** M5 (phase 7)

## Decision
Admins and engineers get an **Annotations** section inside a panel: its annotation sets, and,
on opening one, who is assigned, how far each of them has got, and what each of them selected
on every trace. It is **read-only**. No answer is editable from it, and no control belonging to
the annotator — answering, skipping, stepping back — appears in it.

Staff are never routed into the annotator surface. The gate card's button and the sidebar entry
that did so (M5 phase 5, Deviations 30 and 31) point here instead.

This **revises decision 3 of the M5 plan** ("annotators land on their own surface; staff opt in
per panel via Review traces"). ADR-0064 is untouched: a role still says what you may *do*, and
this adds no capability — reading annotations is already `trace: ['read']` plus `annotation`
membership of the org.

## Context
Decision 3 made the surface a preference, and phase 5 implemented it as a button. Met in a real
console, it read as an ambush: a developer clicking "Review traces" was thrown out of the console
into a different UI entirely, which then answered none of their questions. It could not — it does
not name the set, and it deliberately never shows which answer was selected, because ADR-0066 and
M5 decision 16 give annotators a progress line rather than a history so they are not invited to
second-guess themselves.

That rule is correct for an annotator and useless for a developer, which is the whole argument:
the two need different screens, not one screen reached two ways. A developer's question is
"where is everyone, and what did they say"; an annotator's is "what is the next one".

**Nobody annotates someone else's work.** Read-only is not a permission convenience, it is the
integrity of the record: an annotation is one person's answer, and an engineer able to correct
one would destroy the disagreement M6 exists to measure — the same reason the table is
append-only by grant (ADR-0066). Where a developer thinks an answer is wrong, the remedy is
another annotator on the set (ADR-0081), not an edit.

Whether staff may be *assigned* a set and annotate their own is untouched here and stays with
assignment (ADR-0079); what is settled is that the console never delivers them into it sideways.

Supersedes part of: M5 plan decision 3. Log: `thoughts/shared/progress/decisions-log.md`
(2026-09-21).
