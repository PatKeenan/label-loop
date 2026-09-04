import type { Clock } from '../ports/clock.ts'
import type {
  RateLimitDecision,
  RateLimitPolicy,
  RateLimitStore,
} from '../ports/rate-limit-store.ts'

/**
 * A token bucket, hand-rolled (ADR-0012, ADR-0039) — the third and last of the resilience
 * primitives this project demonstrates, beside `llm/retry.ts` and `llm/breaker.ts`.
 *
 * Retry answers "was that a blip?" and the breaker answers "is this thing down?". The
 * bucket answers the question neither can: "is this caller taking more than their share?"
 *
 * **A bucket rather than a fixed window**, and the difference is the whole design. A fixed
 * window resets on a boundary, so a caller who spends their minute's allowance at 11:59:59
 * gets a second allowance one second later — twice the intended rate across that boundary —
 * and every caller synchronises onto the same edge. A bucket has no edge: it drains as it
 * is spent and refills continuously, so a caller keeps burst headroom for the traffic that
 * genuinely arrives in bunches while the SUSTAINED rate stays exactly `refillPerSecond`.
 *
 * **Its state is two numbers per subject** — tokens, and when they were last counted.
 * That is not an implementation detail, it is what keeps the store swappable
 * (ADR-0039): a design needing more has broken the port.
 */

/**
 * **60 requests per minute per key, burst 60** — stakeholder decision, 2026-09-04. Read as
 * a bucket: a caller may spend a full minute's allowance at once and then sustains one per
 * second.
 *
 * Deliberately loose for a first number, and deliberately a CONSTANT rather than a column:
 * no surface can write a per-key limit until the management API ships, and a configurable
 * limit nobody can configure is a migration with no reader (CONVENTIONS.md:46 under-delivers
 * here knowingly). `docs/BREAKING_POINT.md` is where evidence either tightens this or
 * leaves it alone.
 *
 * Named and exported beside `DEFAULT_RETRY_POLICY` and `DEFAULT_BREAKER_POLICY` so the
 * three tunables of the resilience layer read the same way and live at the same altitude.
 */
export const DEFAULT_RATE_LIMIT: RateLimitPolicy = {
  capacity: 60,
  refillPerSecond: 1,
}

/** What a store persists per subject. Two numbers, and that is the point. */
export type BucketState = {
  tokens: number
  /** When `tokens` was last correct. Refill is computed from the gap, never on a timer. */
  updatedAtMs: number
}

export type BucketTransition = {
  decision: RateLimitDecision
  /** The state to persist. Written even when the call is REFUSED — see below. */
  state: BucketState
}

/**
 * **The algorithm, as a pure function of (state, now, policy).** No clock, no store, no
 * I/O: given the same three inputs it produces the same transition forever, which is what
 * lets the arithmetic be asserted exhaustively in microseconds.
 *
 * It is also the specification the Redis adapter's Lua mirrors. Atomicity forces that
 * duplication — the arithmetic has to run inside the same round trip that reads and writes
 * the state, or it is not atomic — so the two implementations are kept honest by
 * `store.contract-test.ts`, which both must pass. That suite is not decoration here; it is
 * the only thing standing between "the fake and the real store agree" and a hope.
 */
export const consume = (
  state: BucketState | undefined,
  { nowMs, cost, policy }: { nowMs: number; cost: number; policy: RateLimitPolicy },
): BucketTransition => {
  // A subject nobody has seen starts FULL, not empty. A new key whose first request is
  // refused would be indistinguishable from a broken one, and an expired bucket is
  // deliberately identical to a new one — which is what lets the store forget idle
  // subjects instead of remembering every key forever.
  const previous = state ?? { tokens: policy.capacity, updatedAtMs: nowMs }

  // Clamped at zero: a clock that went backwards must not mint tokens. NTP steps happen,
  // and "time moved backwards" should cost the caller nothing rather than pay them.
  const elapsedMs = Math.max(0, nowMs - previous.updatedAtMs)
  const refilled = Math.min(
    policy.capacity,
    previous.tokens + (elapsedMs / 1_000) * policy.refillPerSecond,
  )

  const allowed = refilled >= cost
  const tokens = allowed ? refilled - cost : refilled

  return {
    // The timestamp advances whether or not the call was allowed. It has to: it records
    // when `tokens` was last CORRECT, not when a request last succeeded, and freezing it
    // on refusal would replay the same elapsed gap on the next call and refill twice.
    state: { tokens, updatedAtMs: nowMs },
    decision: {
      allowed,
      // Floored, because 0.9 tokens cannot serve a request that costs 1. Reporting the
      // fraction would promise the caller headroom that is not there yet.
      remaining: Math.floor(tokens),
      retryAfterMs: allowed ? 0 : msToAccrue(cost - tokens, policy),
      resetMs: msToAccrue(policy.capacity - tokens, policy),
    },
  }
}

/** How long `tokens` worth of refill takes. Rounded UP — see the callers' `Retry-After`. */
const msToAccrue = (tokens: number, policy: RateLimitPolicy): number =>
  Math.max(0, Math.ceil((tokens / policy.refillPerSecond) * 1_000))

/**
 * How long a store may forget a subject: the time to refill from empty, plus a second of
 * slack. After that a bucket is full, and a full bucket is exactly what a MISSING one
 * means — so expiry loses nothing and is what stops the store growing by one entry per key
 * that ever called us.
 */
export const bucketTtlMs = (policy: RateLimitPolicy): number =>
  msToAccrue(policy.capacity, policy) + 1_000

export type TokenBucketOptions = {
  store: RateLimitStore
  clock: Clock
  policy?: RateLimitPolicy
}

export type TokenBucket = {
  /** Spend `cost` tokens for `subject`. The clock and the policy are already bound. */
  consume: (subject: string, cost?: number) => Promise<RateLimitDecision>
}

/**
 * The bucket as the middleware uses it: the policy and the `Clock` bound once, the storage
 * delegated. Time arrives through the injected clock rather than `Date.now()` for the same
 * reason it does in `retry.ts` — a limiter whose refill schedule cannot be asserted on is
 * a limiter nobody has checked.
 */
export const createTokenBucket = ({
  store,
  clock,
  policy = DEFAULT_RATE_LIMIT,
}: TokenBucketOptions): TokenBucket => ({
  consume: (subject, cost = 1) => store.consume({ subject, cost, nowMs: clock.now(), policy }),
})
