# ADR-0061: Judges are created only from an eval pass, never free-form

**Status:** Accepted · **Date:** 2026-09-15 · **Milestone:** M4 (the gate), M6 (authoring)

## Decision
The console never offers free-form judge creation. A judge is authored **from an eval pass** — annotations over collected traces, axial-coded into a taxonomy — and carries a link to the evidence that produced it. Until a panel has that evidence, its **Judges section is locked**, shown as a lock in the sidebar rather than hidden.

The gate opens on collected volume first: **50 traces unlocks annotation, and 100 is the ideal first pass** (stakeholder, 2026-09-15) — 50 is a floor, not a goal, and both numbers are shown so the floor is not read as the target. A panel's home shows progress toward it. Traces themselves are visible throughout — the lock is on authoring judges, never on seeing your own data.

## Context
**The reason is the audit trail, not pedagogy** (stakeholder, 2026-09-15). This product's central claim is that a judge encodes a named expert's judgement, and every downstream promise depends on being able to answer *which traces, annotated by whom, produced this judge*: alignment is "κ=0.81 against Sarah's labels, on this held-out set, on this date" (PRODUCT.md 5.7a), the contribution ledger pays against a contributor's share of the annotations in a shipped training set (5.10, §10), and 5.12 treats versioning as evidence. A free-form judge severs that chain at its origin, and no later process can repair it: the traces that would have justified it were never annotated.

It also makes the product's own order real. PRODUCT.md §4 runs traces → open coding → axial coding → judges → alignment. A form that lets someone skip to the end contradicts the loop the product exists to sell, and this repo has already demonstrated how easily that happens — see ADR-0060's note on the placeholder judge invented to satisfy a technical requirement.

## Consequences
- **ADR-0060 moves to M4** (amended there): panels are created collecting, because a panel that cannot convene judges yet must still accept traffic.
- **Panel creation becomes one step** — name, slug, threshold — and the panel's own home becomes the onboarding surface: collecting state, progress toward the annotation threshold, and the integration snippet.
- **The capability-gated model picker moves with judge authoring.** BUILD_SPINE names it as an M4 deliverable; its API half (catalogue, `validate-pin`, the pin's endpoint accounting) shipped in phase 4 and stays. Its UI lands where authoring lands, which is M6.
- **`POST /internal/panels` still accepts judges** at M4, and the console stops sending them. That path remains for seeding and tests until M6 replaces it with taxonomy-derived authoring; the gate is **enforced in the schema** when a judge version is required to cite its provenance. Until then the gate is a console rule, and this ADR is what stops it being quietly re-opened.
- **Open, carried to M6:** how alignment sessions work once judges arrive this way — in particular whether a session belongs to the judge's page or to a panel-level Alignment section, and how a re-alignment cites the round it was run against.

Raised by the stakeholder, 2026-09-15, reviewing the panel-create mockup · Record: `thoughts/shared/progress/decisions-log.md`, `mockups/CONSOLE_FLOW.md` §8 (R9)
