# ADR-0056: Console navigation is a persistent left sidebar

> **Partly superseded by ADR-0062 (2026-09-17):** the "two levels, one persistent sidebar" frame is
> replaced by a persistent top bar and a sidebar that exists only inside a panel. The rest stands.

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
The engineer console navigates by a persistent left sidebar carrying the section nav, the org switcher, a panel switcher, and the signed-in identity and role. Sections M4 does not build are rendered visible but inert. The annotator surface has no shell, by design.

## Context
Stakeholder decision, 2026-09-11. It re-confirms the orphaned decision from the deleted `console-trace-explorer` mockup, with its "classifier switcher" read as a PANEL switcher (ADR-0019) and the org switcher added alongside.

The shell is BUILT rather than only mocked, so the console's screens are things that go inside something that exists rather than three screens each inventing a layout. Whether inert sections are shown disabled or hidden entirely is deliberately left to the shell's own design review.

Plan: `thoughts/shared/plans/approved/2026-09-11_m4-console-auth.md` (Decisions made)

## Amendment — 2026-09-14, at the review of `console-shell.html` (M4 phase 6b)
The sidebar stays persistent and left; what it carries, and in what order, is refined. It has **two levels in one sidebar — Home and a panel.** Under the wordmark, a Home link reads "← Home" from inside a panel. Below it, a panel switcher REPLACES the "Panels" section (Home is the panel list), and the section nav beneath it is always about exactly that one panel — there is no All-panels mode. The org switcher moves to the **foot**, beside identity, and is a menu only for an account in more than one org. Organisation settings (Audit log, Billing) sit at the foot for admins only and are absent until M8 (ADR-0059).

Why: once the panel switcher is the primary control, every nav item reads as belonging to the selected panel, so org-level entries in the same list break the reading; and the org switcher is the least-touched control in the console, which the top slot overstated. Rejected: a sidebar that swaps its contents on entering a panel, which hides Home behind a back button and is no longer persistent. Cost accepted: no cross-panel Traces or Keys view in M4–M7. Full record: `mockups/CONSOLE_FLOW.md` §8.
