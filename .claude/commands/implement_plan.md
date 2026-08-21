Implement an approved plan. Argument: path in thoughts/shared/plans/approved/.
If the path is in drafts/, REFUSE and point to /approve_plan. If no path, ask.

1. Read the plan, CLAUDE.md, docs/CONVENTIONS.md, and the ADRs the plan references.
   That is your context. Do not re-research unless reality contradicts the plan.
2. Implement phase by phase, fully completing one before starting the next:
   - Follow the plan's intent while adapting to what you actually find.
   - Update the plan's checkboxes as you complete steps (edit the file in place).
   - Run the phase's automated verification; fix until green.
   - Then PAUSE: tell the human the phase is ready for manual verification and wait.
3. If reality diverges from the plan, stop and report:
   "Issue in Phase N — Expected: <plan> / Found: <actual> / Why it matters / Options"
   and wait for direction. Material deviations get recorded in the plan file under a
   "Deviations" section (they are decision provenance too).
4. Respect CONVENTIONS at all times: envelope, error taxonomy, logging rules, ports.
   Never introduce a dependency not in STACK_DECISIONS.md or the plan.
5. When all phases are verified: set status: complete, move the plan to
   thoughts/shared/plans/complete/ (git mv), update docs/SENIORITY_CHECKLIST.md if an
   artifact went live, and summarize what shipped vs. what deviated.
