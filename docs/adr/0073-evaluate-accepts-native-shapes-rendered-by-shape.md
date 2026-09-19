# ADR-0073: Evaluate accepts native shapes in four roles; LabelLoop renders by shape

**Status:** Accepted · **Date:** 2026-09-19 · **Milestone:** M5 (lands before phase 4)
**Amends:** the evaluate contract (ADR-0019) · **Excepts:** CONVENTIONS "Breaking change = new version"

> Stub from `/log_decision`. Rationale is in `thoughts/shared/progress/decisions-log.md`
> (2026-09-19T00:30Z). Expand when the contract-change plan settles the details.

## Decision
`POST /v1/panels/{id}/evaluate` (and the single-judge route) take four roles instead of
`artifact` + `context`:

| Field | Required | Shape | Meaning |
|---|---|---|---|
| `input` | yes | any JSON | what the agent was given — for a chat, its messages array |
| `output` | yes | any JSON | what it produced — the thing judged |
| `reference` | no | object | facts needed to judge it (an account record) |
| `metadata` | no | object of strings | bookkeeping (a conversation id); for filtering and grouping, never in the reading flow |

LabelLoop, not the integrator, decides presentation, **by shape**: a string renders as markdown
text; an array of `{role, content}` (the message format every agent framework already holds)
as a transcript; an object as labelled fields; anything else as formatted JSON. The trace and
annotator views read **chronologically — input, then output** — so a chat reply appears as the
next turn of its own conversation, highlighted. Reference material shared by every call (a
policy) belongs on the **panel version**, shown once and given to its judges; per-call
`reference` is for facts that change per call. Judges receive the structure, not a rendering.

**Amended in place on `/v1`, not a `/v2`.** A recorded exception to CONVENTIONS' rule that a
breaking change is a new version: the rule exists to protect callers, and on 2026-09-19 none
exists outside this repository (the seed, k6 and the throwaway spikes). The exception does not
generalise — once an external caller exists, the rule applies without exception.

## Context
Two real spikes (2026-09-18: a GitHub triage agent and a support chat, both via OpenRouter into
collecting panels, 130 traces) showed three faults with strings-only `artifact` + `context`: the
integrator had to write a render function (the triage decision) and flatten a transcript; the
trace read backwards, output first and its conversation after; and every context field — a
30-line policy, a bookkeeping id, the customer's words — carried equal weight. The onboarding
snippet itself taught the ambiguity (`your_agent_decision` inside `context`).

Alternatives: keep `artifact` + `context` with better docs; add `input` and a separate ordered
`history` field (unneeded — for a chat the messages array IS the input); a clean `/v2`.

## Consequences
- M5 pauses after phase 3 for a contract-change plan: contract, storage, judge prompts, the
  onboarding snippet, the trace view, k6 and the seed. Phase 4's review payload is built on
  the new shape; r5 is redrawn for it.
- Size limits move from a string length to a serialized-JSON byte cap.
- Rendering by shape needs one shared renderer (console and annotator), with markdown rendered
  safely.
