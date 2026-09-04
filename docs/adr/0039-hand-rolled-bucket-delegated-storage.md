# ADR-0039: The token bucket is hand-rolled; only the storage is delegated

**Status:** Accepted · **Date:** 2026-09-04 · **Milestone:** M2
**Applies:** ADR-0012

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-04_m2-resilience-load-baseline.md`. Expand if the
> decision is challenged or its consequences grow.

## Decision

**The bucket is hand-rolled; only the storage is delegated.** ADR-0012 makes this a standing
principle and `retry.ts` states the reasoning: these primitives are the Category-5 artefact,
so importing one hands away the thing being demonstrated. The Lua script is the exception
that proves it — atomicity is a property of the store, not behaviour we could hand-roll
correctly anyway.

**The counter store is a port with a real adapter and a deterministic fake**, matching
`ModelProvider`. It is what makes [ADR-0038](0038-redis-adopted-ahead-of-its-evidence-gate.md)
reversible if phase 3's numbers embarrass it, and it is why the store choice does not have to
be right first time.

**The real adapter is Bun's built-in `Bun.RedisClient`, so Redis adds no npm dependency.**
Bun 1.4.0 ships a Redis client with `eval`/`evalsha`, which is everything an atomic token
bucket needs. Judged by what it would replace (`ioredis` or `node-redis`): the built-in
replaces it entirely, so the package would buy nothing. This is a runtime capability, not a
resilience library — it does not touch ADR-0012, which is about not importing the *behaviour*.

## Context

The rate limiter is one of the Category-5 artefacts this project exists to demonstrate, so
the algorithm stays ours while the two things that are genuinely infrastructure — durable
counters and atomic read-modify-write — go behind a port with a real adapter and a
`Clock`-driven fake that both pass the same contract suite.

## Consequences

- **The bucket's state is two numbers per subject**, which is what keeps the store swappable;
  a design that needs more has broken the port.
- **The fake is a peer, not a stub.** Both adapters pass `store.contract-test.ts`, the way
  `fake-provider` and `openrouter-provider` do, so the limiter's tests never sleep and never
  need a reachable Redis.
- Promoting a runtime capability to a load-bearing dependency ties the API to Bun more
  tightly than ADR-0004's "swap the entrypoint" claim assumes — bounded here to one adapter
  file behind the port.

Plan: `thoughts/shared/plans/approved/2026-09-04_m2-resilience-load-baseline.md`
Provenance: `thoughts/shared/research/2026-09-04_m2-resilience-load-baseline.md`
Related: ADR-0012, ADR-0038, ADR-0004
