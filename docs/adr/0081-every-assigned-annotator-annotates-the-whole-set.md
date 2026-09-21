# ADR-0081: Every assigned annotator annotates the whole set; the dictator's answer counts

**Status:** Accepted · **Date:** 2026-09-20 · **Milestone:** M5 (phase 7)
**Supersedes:** ADR-0066's "one person per trace"

> **Renamed 2026-09-21 (ADR-0085).** "Review set" is now **annotation set**, and the file name
> with it. The decision below is unchanged; only its noun is.

## Decision
Each annotator assigned to a set annotates all of it: a trace leaves YOUR queue when YOU have
answered it, not when anybody has. The overlap is simply how many annotators were assigned — there
is no overlap number to configure. When there is more than one, the developer names one of them
the DICTATOR at assignment (one per set, enforced by a partial unique index; two annotators and no
dictator is refused), and where answers differ **the dictator's is the one that counts**. That is
a READ rule: no split queue, no arbitration screen, no resolution object, and nothing waiting on
anybody. Every answer stays on the table. An annotator never sees another annotator's answer.

## Context
ADR-0066's rule was written when the queue was the whole panel and a second opinion had nowhere to
live. Recording overlaps is standard evaluation practice and the raw material for the agreement
metrics M6 owns; resolving them as a workflow would be machinery with nothing yet to protect.
Withholding other annotators' answers is ADR-0067's reasoning pointed at people rather than at a
judge: knowing what someone else said is the strongest anchor there is, and agreement measured
after it is not agreement. A set is COMPLETE when every assigned annotator has answered every
trace, so a set is not "done" while one person's half is outstanding.

Plan: `thoughts/shared/plans/superseded/2026-09-20_review-sets.md` (decisions 5, 6, 7, 8, 14, 16),
carried into `thoughts/shared/plans/approved/2026-09-21_annotation-sets.md`
