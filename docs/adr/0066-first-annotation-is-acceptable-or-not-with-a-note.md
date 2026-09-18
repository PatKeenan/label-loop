# ADR-0066: The first annotation is acceptable / not acceptable plus a note, from a per-panel random queue

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5

## Decision
At M5 an annotation is **open coding**: the annotator reads the trace pair and records *acceptable* or *not acceptable*, with a ≤280-character note **required when not acceptable**, or skips for free. The queue is **per panel**, serves traces at **random** from those nobody has annotated yet (the sampler is recorded on every row), unlocks at 50 traces (ADR-0061), and serves each trace to one person — a skip frees it for someone else. The schema permits many annotations per trace.

## Context
The only prior design (harvest `annotator-session` r4) was agree/correct against a judge verdict, and ADR-0060/0061 made every new panel start with no judges. The binary is what M6 aligns judges against; the note is what axial coding clusters. Low-confidence, disagreement and honeypot samplers need judges or gold labels.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decisions 2, 4, 5, 7)
