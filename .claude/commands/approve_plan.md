Finalize a human-approved plan. Argument: path of a plan in thoughts/shared/plans/drafts/.

Run ONLY after the human has explicitly said the plan is approved in this session.
If they haven't, STOP and ask for explicit approval.

1. Verify the plan has: milestone, phases with checkboxes, verification steps, and a
   "Decisions made" section. If anything is missing, fix it with the human first.
2. Set header status: approved, add approved_at timestamp and approver name.
3. Move the file to thoughts/shared/plans/approved/ (git mv).
4. For each entry in "Decisions made" that is architecturally significant (would come
   up in an interview): create docs/adr/NNNN-<slug>.md as a stub — Status: Accepted,
   Decision (from the plan line), Context (one sentence), link back to the plan file.
   Number sequentially after the highest existing ADR.
5. Commit: "plan: approve <slug> (+ ADR NNNN..)" and print a summary.
6. Remind the human: clear context (/clear) before running /implement_plan — the
   approved plan is designed to be the ONLY context implementation needs.
