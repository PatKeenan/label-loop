import { describe, expect, test } from 'bun:test'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import type { RateLimitPolicy } from '../ports/rate-limit-store.ts'
import { createMemoryRateLimitStore } from './memory-store.ts'
import {
  type BucketState,
  bucketTtlMs,
  consume,
  createTokenBucket,
  DEFAULT_RATE_LIMIT,
} from './token-bucket.ts'

/**
 * The arithmetic, asserted directly and exhaustively. Nothing here sleeps: `consume` is a
 * pure function of (state, now, policy), which is exactly what makes a refill schedule
 * something to assert rather than something to wait for — the same reasoning `retry.ts`'s
 * backoff tests are built on.
 *
 * The shared store contract (`store.contract-test.ts`) asserts the same behaviour THROUGH
 * a store, against both adapters. This file asserts it on the function the TypeScript
 * adapter uses and the Lua transcribes, so a broken transition is localised here rather
 * than being read off a failing integration test.
 */

/** Small and fast, so every token boundary is legible. */
const POLICY: RateLimitPolicy = { capacity: 5, refillPerSecond: 1 }

const at = (state: BucketState | undefined, nowMs: number, cost = 1) =>
  consume(state, { nowMs, cost, policy: POLICY })

describe('the default policy', () => {
  test('is 60 per minute, burst 60 — the stakeholder’s number, in the units it was given in', () => {
    expect(DEFAULT_RATE_LIMIT.capacity).toBe(60)
    // One per second sustained, which is 60 a minute. Both halves matter: the capacity is
    // the burst a caller may spend at once, the refill is what they sustain afterwards.
    expect(DEFAULT_RATE_LIMIT.refillPerSecond).toBe(1)
  })
})

describe('a bucket nobody has seen', () => {
  test('starts full, so a new key’s first request is not refused', () => {
    const { decision, state } = at(undefined, 5_000)
    expect(decision.allowed).toBe(true)
    expect(decision.remaining).toBe(POLICY.capacity - 1)
    expect(state.updatedAtMs).toBe(5_000)
  })
})

describe('burst and exhaustion', () => {
  test('spends exactly `capacity` at one instant, then refuses', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) {
      const transition = at(state, 1_000)
      expect(transition.decision.allowed).toBe(true)
      expect(transition.decision.remaining).toBe(POLICY.capacity - 1 - i)
      state = transition.state
    }
    expect(at(state, 1_000).decision.allowed).toBe(false)
  })

  test('a refusal deducts nothing, so retrying eagerly cannot dig the hole deeper', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state

    const first = at(state, 0)
    const second = at(first.state, 0)
    expect(second.decision.allowed).toBe(false)
    expect(second.decision.retryAfterMs).toBe(first.decision.retryAfterMs)
    expect(second.state.tokens).toBe(first.state.tokens)
  })

  test('the timestamp advances on a REFUSAL too — otherwise the same gap refills twice', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state

    // Refused at 500ms. If `updatedAtMs` stayed at 0, the call at 1000ms would count the
    // gap from 0 rather than from 500 and mint a second token out of nothing.
    const refused = at(state, 500)
    expect(refused.decision.allowed).toBe(false)
    expect(refused.state.updatedAtMs).toBe(500)

    const next = at(refused.state, 1_000)
    expect(next.decision.allowed).toBe(true)
    expect(next.state.tokens).toBeCloseTo(0, 10)
  })

  test('a cost larger than the bucket is refused rather than promised', () => {
    // Unsatisfiable at any time. Answering "no" is honest; a `Retry-After` would be a
    // promise that is still false when it expires.
    expect(at(undefined, 0, POLICY.capacity + 1).decision.allowed).toBe(false)
  })
})

describe('refill', () => {
  test('is continuous, not a window that hands back the whole allowance on a boundary', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state

    expect(at(state, 500).decision.allowed).toBe(false)
    expect(at(state, 1_000).decision.allowed).toBe(true)
    // Two seconds is two tokens, not a reset: spend both and the third is refused.
    let after = at(state, 2_000)
    expect(after.decision.allowed).toBe(true)
    after = at(after.state, 2_000)
    expect(after.decision.allowed).toBe(true)
    expect(at(after.state, 2_000).decision.allowed).toBe(false)
  })

  test('stops at `capacity` — an idle caller banks nothing', () => {
    const spent = at(undefined, 0)
    // An hour of silence. The bucket is full, not full plus an hour's worth.
    const { state } = at(spent.state, 3_600_000)
    expect(state.tokens).toBe(POLICY.capacity - 1)
  })

  test('mints nothing when the clock goes backwards', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 10_000).state
    // NTP steps happen. Time moving backwards should cost the caller nothing, and pay them
    // nothing either.
    expect(at(state, 5_000).decision.allowed).toBe(false)
  })
})

describe('the numbers a 429 is built from', () => {
  test('`retryAfterMs` is exact: a millisecond early is refused, the promised moment works', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state

    const refused = at(state, 0)
    expect(refused.decision.retryAfterMs).toBe(1_000)
    expect(at(state, refused.decision.retryAfterMs - 1).decision.allowed).toBe(false)
    expect(at(state, refused.decision.retryAfterMs).decision.allowed).toBe(true)
  })

  test('`retryAfterMs` scales with the cost, not with a constant', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state
    // Three tokens short is three seconds, which is the whole reason the header is computed
    // from the bucket rather than being a fixed number in the middleware.
    expect(at(state, 0, 3).decision.retryAfterMs).toBe(3_000)
  })

  test('`retryAfterMs` is rounded UP, so a retry never lands a fraction too early', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state
    // 0.4 of a token accrued: 600ms still owed, and 0.6s must not round to 0.
    expect(at(state, 400).decision.retryAfterMs).toBe(600)
  })

  test('`resetMs` counts down to a FULL bucket, not to the next single token', () => {
    const first = at(undefined, 0)
    expect(first.decision.resetMs).toBe(1_000)
    expect(at(first.state, 0).decision.resetMs).toBe(2_000)
  })

  test('`remaining` is floored — 0.9 of a token cannot serve a request costing 1', () => {
    let state: BucketState | undefined
    for (let i = 0; i < POLICY.capacity; i++) state = at(state, 0).state
    const partial = at(state, 900)
    expect(partial.decision.allowed).toBe(false)
    expect(partial.decision.remaining).toBe(0)
  })
})

describe('bucketTtlMs', () => {
  test('outlasts a refill from empty, because only then is forgetting the bucket free', () => {
    // Below this, expiry would hand a throttled caller a full bucket early. Above it, the
    // store is remembering a bucket that is already full and therefore says nothing.
    expect(bucketTtlMs(POLICY)).toBeGreaterThan((POLICY.capacity / POLICY.refillPerSecond) * 1_000)
  })
})

describe('createTokenBucket', () => {
  test('binds the clock and the policy, so the caller supplies neither', async () => {
    const clock = createFixedClock()
    const bucket = createTokenBucket({
      store: createMemoryRateLimitStore(),
      clock,
      policy: POLICY,
    })

    for (let i = 0; i < POLICY.capacity; i++) expect((await bucket.consume('k')).allowed).toBe(true)
    expect((await bucket.consume('k')).allowed).toBe(false)

    // Time advances without waiting — the point of the injected clock.
    clock.advance(1_000)
    expect((await bucket.consume('k')).allowed).toBe(true)
  })

  test('defaults to the shipped policy when none is given', async () => {
    const bucket = createTokenBucket({
      store: createMemoryRateLimitStore(),
      clock: createFixedClock(),
    })
    const first = await bucket.consume('k')
    expect(first.remaining).toBe(DEFAULT_RATE_LIMIT.capacity - 1)
  })
})
