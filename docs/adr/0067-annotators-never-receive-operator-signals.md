# ADR-0067: Operator signals never reach the annotator — enforced in the API payload

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5

## Decision
The annotate endpoints return an annotator **only the trace pair** (artifact and context) and progress. No verdict, score, confidence, model, cost, key or trace id is in the response at all, so the annotator surface cannot leak what it never receives. Tests assert the payload's keys.

## Context
Harvest blocker 2, adopted: automation bias is asymmetric — visible confidence systematically inflates agreement, which is the metric M6 exists to measure honestly — and naming low confidence would leak which sampler served the item. Enforcing it in the payload rather than the UI means no future screen can reintroduce it by accident.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decision 8)
