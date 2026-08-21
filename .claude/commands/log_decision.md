Quick-capture a decision made in conversation, so rationale is never lost.
Argument: one-line description of the decision.

1. Ask the human (if not obvious from the current session): what was decided, what
   were the alternatives, why this one, is it significant enough for an ADR?
2. Append a timestamped entry to thoughts/shared/progress/decisions-log.md:
   `- 2026-08-19T14:30Z [author] <decision> — over <alternatives> because <rationale>
   (milestone MN)`. Create the file with a header if it doesn't exist.
3. If significant (pattern/dependency/trade-off an interviewer would probe): also
   create the ADR stub in docs/adr/ (next number, Status: Accepted, link the log).
4. Print what was recorded. Do not start any other work.
