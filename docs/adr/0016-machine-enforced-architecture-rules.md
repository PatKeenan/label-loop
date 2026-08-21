# ADR-0016: Architectural rules are machine-enforced, not remembered

**Status:** Accepted · **Date:** 2026-08-21

## Decision
Rules that would otherwise erode under future pressure are enforced by a lint rule or an
architecture test rather than by documentation. The first is CONVENTIONS.md's "only
`llm/` may call a provider", asserted by a test that no provider `fetch` exists elsewhere.

## Context
The single-gateway rule is the one most likely to erode when M7 introduces multi-provider
routing and a shortcut looks harmless. The same reasoning already appears elsewhere in the
codebase: the frontend's exhaustive error-code switch makes a new backend error code fail
the web typecheck, so front/back error sync is structural rather than remembered.

## Consequences
- Violations fail CI at the moment they are introduced, not at review.
- Each such rule costs a test to write and must be kept honest as the codebase grows.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-G)
