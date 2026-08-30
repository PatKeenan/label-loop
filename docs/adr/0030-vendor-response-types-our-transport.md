# ADR-0030: The provider's response types, our transport

**Status:** Accepted · **Date:** 2026-08-30 · **Milestone:** M1

## Decision
`@openrouter/sdk` is a dependency of `apps/api`, used for **exactly one thing**: decoding a
chat-completion response. `chatResultFromJSON` parses the body and `ChatResult` types it.

Nothing else from the package is used. The request still goes out on plain `fetch`, and every
resilience primitive stays hand-rolled in the gateway (ADR-0012). The package is added to
`architecture.test.ts`'s import fence like any other provider SDK, so it cannot be reached
outside `apps/api/src/llm/`.

This **amends ADR-0021**, which rejected "client-side abstraction libraries" outright.
That rejection stands for what it was aimed at — the Vercel AI SDK and LangChain, which
normalise the call and hide retry, backoff and error mapping. It over-reached in also
excluding a vendor's own type definitions, which hide nothing.

Recorded as STACK_DECISIONS **D16**. Stakeholder decision, 2026-08-30.

## Context
P2 shipped with a hand-written `OpenRouterResponse`: every field optional, because nothing
could verify it. The stakeholder's objection was that this is brittle by construction, and it
is — a hand-written wire type cannot fail. If OpenRouter renames a field, typecheck stays
green and the adapter silently reads `undefined`. `usage.cost` becoming `undefined` means
`cost_priced: false` on every row, which ADR-0027 designed as a rare signal and which would
instead become the normal case, unnoticed.

**The package costs almost nothing.** `@openrouter/sdk` depends on `zod` alone, which is
already in the tree — so CONVENTIONS' "no large transitive tree" constraint, the usual
objection, does not apply here.

### What was inspected before adopting it
Their transport was read rather than assumed, and it is a good illustration of why ADR-0012
exists:

| | Theirs | Ours |
|---|---|---|
| Retry ceiling | `maxElapsedTime: 3_600_000` — one hour | 3 attempts |
| Jitter | `initial * x^1.5 + Math.random() * 1000` | full jitter: uniform over `[0, capped)` |
| Randomness | `Math.random()`, not injectable | injected, so the schedule is asserted |
| Circuit breaker | none | per-model, with a half-open probe |

An hour of elapsed retry inside a judge call a customer's agent is waiting on is not a
policy we could adopt, and jitter added *on top of* a deterministic base does not break the
convoy that full jitter exists to break. So the transport is not a close call — it is
strictly worse for this system, and the split lands where the value is.

**The decode is the opposite case.** It is generated from their API definition and it knows
things we did not:

- `EndpointInfo.selected: boolean`. The hand-written code read `available[0].model` as
  `served_by`. `available` is the whole pool that survived the pin — five of nine for Sonnet 5
  — and exactly one of them answered. Position zero names a **real endpoint that served
  nothing**, which is worse than naming none: a plausible wrong answer in the field ADR-0022
  says routing-drift queries depend on. This was a live bug, found by adopting the types.
- `EndpointsMetadata.total` beside `available`, making explicit that ADR-0026's recorded
  count is the pool the pin *left*, not the catalogue it was drawn from.

### The risk, measured rather than assumed
A vendor schema can reject a response our permissive types would have accepted. The shipped
schema was probed:

- Unknown fields, top-level and nested, are **stripped, not rejected** — so a field OpenRouter
  adds tomorrow cannot break a working call. This is the common drift and it is safe.
- A **removed required field** does fail (`system_fingerprint` was the probe). That is the
  real exposure, and it is bounded: a decode failure is `invalid_output` — the call completed
  and what came back is not something we can read — never a crash, never a retry, with `raw`
  retained so the diagnosis survives.

Both properties have tests.

### Alternatives considered
**Keep the hand-written types.** Free and already written. Rejected: it is the brittleness
that prompted this, and it had already produced one wrong `served_by`.

**Use the SDK as the client.** Rejected on the table above, and because it would delete the
resilience work this project exists to demonstrate (ADR-0012).

**`@openrouter/ai-sdk-provider`.** Pulls in `ai@^7` and is precisely what ADR-0021 rejected.

## Consequences
- Response-shape drift becomes a typecheck or a parse failure instead of a silent `undefined`.
- Fixtures must now be realistic wire payloads. Three test fixtures were fictional and were
  caught immediately, which is the benefit arriving early.
- The import fence gains `openrouter` and is narrowed to **bare specifiers** with `(?!\.)`,
  so it does not fire on `server.ts` importing our own adapter — the composition root's job.
  A rule that flags the file that is supposed to do the thing teaches people to weaken it.
- ADR-0021's rejection of abstraction libraries is unchanged for the Vercel AI SDK and
  LangChain. The narrower reading is now on the record so it is not re-litigated.
- One more thing to keep current. A major bump wants reading, since the decode is the only
  surface we use and it is the one that changes with their API.

Log: `thoughts/shared/progress/decisions-log.md` (2026-08-30)
Register: STACK_DECISIONS D16 · Amends: ADR-0021 · Related: ADR-0012, ADR-0022, ADR-0026, ADR-0027
