# ADR-0085: The product says annotation, not review

**Status:** Accepted · **Date:** 2026-09-21 · **Milestone:** M5 (phase 7)

## Decision
One word for the act, everywhere: **annotation**. A curated set of traces is an **annotation
set**; the console section is **Annotations**; the annotator's own surface annotates rather than
reviews. "Review" is retired from the product's vocabulary.

ADR-0079 through ADR-0083 are **renamed, not superseded** — every decision in them stands; their
noun changes.

## Context
The database has said `annotations` since migration 0015, and the capability has been
`annotation: ['create']` since ADR-0064. "Review" arrived later and only in the layers built on
top: the queue, its routes, the surface, and then the set. Two words for one act is how a console
starts telling two stories about the same table, and the one that has to go is the one the schema
never used.

It reaches the annotator surface too, including r6's wording, which the stakeholder approved on
2026-09-20 under the old word. Renaming what the annotator reads is the point rather than an
unfortunate consequence: telling the person doing the annotating that they are reviewing is
exactly the drift this closes.

A rename is cheap now and expensive later — every ADR, route and component added under the old
noun is one more thing to change — which is why it lands with phase 7 rather than after it.

Log: `thoughts/shared/progress/decisions-log.md` (2026-09-21).
