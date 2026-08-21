Create an implementation plan from research. Argument: research doc path (or topic —
if no research doc exists for it, say so and suggest /research first).

1. Read the research doc, CLAUDE.md, docs/BUILD_SPINE.md (confirm which milestone this
   serves — if none, STOP and flag as scope creep per PARKING_LOT rules),
   docs/CONVENTIONS.md, and any ADRs the research cites.
2. Write a plan to thoughts/shared/plans/drafts/YYYY-MM-DD_<topic-slug>.md with:
   - Header (thoughts/README.md convention), status: draft
   - Goal (one paragraph) + milestone it serves
   - Phases: each with concrete file-level changes, success criteria, and a
     "- [ ]" checkbox per verifiable step
   - Automated verification per phase (commands to run: tests, typecheck, lint)
   - Manual verification per phase (what the human should check)
   - "Decisions made" section: every pattern/dependency/trade-off/scope-cut choice
     this plan embeds, one line each with rationale — these become ADR stubs
   - "Explicitly NOT doing" section
3. Respect stack ownership: if the plan would introduce ANY technology not in
   docs/STACK_DECISIONS.md, STOP and ask — never decide it inside a plan.
4. Print the path, the Decisions made list, and the open questions. Then STOP and
   wait for human steering. Revise in place under steering; do not implement.
