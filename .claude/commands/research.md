Research a topic in this codebase/project before any planning. Argument: the topic.

1. Read CLAUDE.md and every doc it references that is relevant to the topic
   (BUILD_SPINE for milestone context, CONVENTIONS, relevant ADRs, PRODUCT sections).
2. Investigate the actual code (if any exists yet) — find the relevant files, trace
   the information flow, identify existing patterns that constrain the approach.
3. Write a research doc to thoughts/shared/research/YYYY-MM-DD_<topic-slug>.md using
   the header convention in thoughts/README.md, containing ONLY:
   - Problem summary (2-4 sentences)
   - Relevant files/modules and why each matters (one line each)
   - Existing patterns and constraints that apply (cite CONVENTIONS/ADRs by name)
   - Open questions for the human
   - Recommended approach (short; this is input to planning, not the plan)
4. Keep it dense: the doc should compress everything you read into what the NEXT
   session needs — it replaces raw exploration, it does not transcribe it.
5. Print the file path and the open questions, then STOP. Do not plan. Do not code.
