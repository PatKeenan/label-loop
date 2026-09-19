# ADR-0078: Markdown is rendered with `markdown-to-jsx`, raw HTML disabled

**Status:** Accepted · **Date:** 2026-09-19 · **Milestone:** M5

## Decision
String roles render as markdown through `markdown-to-jsx`, with raw HTML disabled, in the one shared renderer used by the console and the annotator view. Recorded as a STACK_DECISIONS row in phase 3.

## Context
Agent output is untrusted text. The stakeholder chose a package over a hand-rolled subset. `react-markdown` is safe by default but pulls the unified/remark tree, against CONVENTIONS' "no large transitive tree". `markdown-to-jsx` has no dependencies, is maintained, and renders to React elements.

Plan: `thoughts/shared/plans/approved/2026-09-19_evaluate-native-shapes.md` (decision 9)
