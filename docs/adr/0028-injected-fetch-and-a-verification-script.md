# ADR-0028: The adapter's `fetch` is injected, and live verification is a script

**Status:** Accepted · **Date:** 2026-08-29 · **Milestone:** M1

## Decision
`createOpenRouterProvider` takes `fetch` as a parameter, so the shared `ModelProvider`
contract suite runs against the real adapter offline and deterministically. Verification
against the live API is a **script** (`bun run verify:pin`) plus the seed's own pin
validation — **never a test that skips when a key is absent**.

## Context
CI already refuses to skip the database tests, because a claim about what Postgres does that
silently passes without a Postgres proves nothing. A network test gated on a secret is the
same defect wearing different clothes: it reports green in exactly the environment where it
proved least.

## Consequences
- Every row of the adapter's failure-mapping table is testable without a network or a bill.
- The live path is exercised deliberately by a human, and the same code that validates a pin
  at creation is the code that verifies it by hand — one mechanism, not two.
- `verify:pin` is also how the per-attempt timeout is re-derived against a real frontier call
  rather than inherited from a number chosen against a fake.

Full rationale: `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` (P2, Decisions 7, 8, 14).
