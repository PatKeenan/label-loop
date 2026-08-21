# thoughts/ — decision provenance trail

Working artifacts of the research → plan → implement workflow. Everything here is
version-controlled: this directory is the raw material for the final writeup and the
proof that every architectural choice had a rationale (interview pressure-testing).

## Structure
- `shared/research/`  — codebase/domain research docs. Read before planning.
- `shared/plans/drafts/`    — plans awaiting human review. NEVER implemented from.
- `shared/plans/approved/`  — human-approved plans. The ONLY implementation source.
- `shared/plans/complete/`  — finished plans (moved on completion, checkboxes done).
- `shared/progress/` — running progress docs for multi-session work.
- `scratch/`         — free-form scratchpad; no format rules; prunable.

## Header convention (every file in shared/)
```
---
date: 2026-08-19T14:30:00Z
author: <your name> | claude-code
status: draft | approved | complete | superseded
milestone: M0..M8 (from docs/BUILD_SPINE.md)
topic: short-slug
related_adrs: [0004, 0007]   # if any
---
```
Filenames: `YYYY-MM-DD_short-slug.md`.

## Rules
- Approval is a human act. Files move from drafts/ to approved/ only via /approve_plan
  after explicit human sign-off in the session.
- Any plan that makes a decision worth defending in an interview (pattern, dependency,
  trade-off, scope cut) must name it in a "Decisions made" section — /approve_plan
  turns those into ADR stubs so nothing gets lost.
