# ADR-0056: Console navigation is a persistent left sidebar

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The engineer console navigates by a persistent left sidebar carrying the section nav, the org switcher, a panel switcher, and the signed-in identity and role. Sections M4 does not build are rendered visible but inert. The annotator surface has no shell, by design.

## Context
Stakeholder decision, 2026-09-11. It re-confirms the orphaned decision from the deleted `console-trace-explorer` mockup, with its "classifier switcher" read as a PANEL switcher (ADR-0019) and the org switcher added alongside.

The shell is BUILT rather than only mocked, so the console's screens are things that go inside something that exists rather than three screens each inventing a layout. Whether inert sections are shown disabled or hidden entirely is deliberately left to the shell's own design review.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)
