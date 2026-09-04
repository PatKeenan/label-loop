import type { RateLimitStore } from '../ports/rate-limit-store.ts'
import { type BucketState, bucketTtlMs, consume } from './token-bucket.ts'

/**
 * The in-process store, and a *peer* of the Redis adapter rather than a stub of it: it
 * implements the same port and passes the same contract suite (ADR-0039), which is what
 * makes the limiter's tests deterministic, sleepless, and free of a running Redis.
 *
 * It is honest about what it is not. A `Map` in one process cannot limit a caller across
 * replicas — two instances would each grant a full bucket — so this is the fake and the
 * test double, never the production adapter. What it demonstrates is that the algorithm
 * and the storage really are separable: the same `consume` from `token-bucket.ts` runs
 * here, and the Lua in `redis-store.ts` mirrors it.
 *
 * Atomicity comes free rather than by design: a single-threaded event loop with no `await`
 * between the read and the write cannot interleave two consumes. That is a property of
 * this runtime, which is exactly why the REAL store cannot rely on the same reasoning.
 */
export const createMemoryRateLimitStore = (): RateLimitStore => {
  const buckets = new Map<string, BucketState & { expiresAtMs: number }>()

  return {
    consume: async ({ subject, cost, nowMs, policy }) => {
      const existing = buckets.get(subject)
      // Expiry is checked on read rather than swept on a timer: a `Map` in a request path
      // should not own a background interval, and an expired bucket is indistinguishable
      // from an absent one anyway (both mean "full").
      const state = existing !== undefined && existing.expiresAtMs > nowMs ? existing : undefined

      const { decision, state: next } = consume(state, { nowMs, cost, policy })
      buckets.set(subject, { ...next, expiresAtMs: nowMs + bucketTtlMs(policy) })

      // Bounded cleanup, amortised over the calls that come anyway. Without it a long-lived
      // process leaks one entry per subject that ever called, which is the same unbounded
      // growth the TTL exists to prevent in Redis.
      if (buckets.size > MAX_TRACKED_SUBJECTS) {
        for (const [key, bucket] of buckets) {
          if (bucket.expiresAtMs <= nowMs) buckets.delete(key)
        }
      }

      return decision
    },

    close: async () => {
      buckets.clear()
    },
  }
}

/** When to bother sweeping. High enough that a test never triggers it by accident. */
const MAX_TRACKED_SUBJECTS = 10_000
