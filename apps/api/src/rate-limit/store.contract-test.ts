import { describe, expect, test } from 'bun:test'
import type { RateLimitPolicy, RateLimitStore } from '../ports/rate-limit-store.ts'
import { bucketTtlMs } from './token-bucket.ts'

/**
 * The shared contract every `RateLimitStore` adapter must satisfy (CONVENTIONS.md: "Base
 * test suites live beside each port"). The in-memory fake and the Redis adapter import
 * this same file rather than each writing its own idea of the contract — which is the only
 * way "the fake is a peer of the real one" (ADR-0039) is a claim rather than an aspiration.
 *
 * It matters more here than it does for `ModelProvider`, because the bucket arithmetic is
 * genuinely written twice: once in TypeScript in `token-bucket.ts`, and once in Lua inside
 * `redis-store.ts`, because atomicity forces the arithmetic into the same round trip as
 * the read and the write. This suite is the only thing keeping the two transcriptions in
 * step, and a divergence it did not catch would surface as a limit that is quietly wrong
 * in production and exactly right in every unit test.
 *
 * Time is a parameter throughout: nothing here sleeps, and both adapters are driven by the
 * same injected `nowMs`, so a refill schedule is asserted rather than waited for.
 *
 * The filename is `-test`, not `.test`, on purpose — this file defines a suite, it does not
 * run one. The runner's patterns all miss it, so it executes only where an adapter calls it.
 */

/** Small and fast: five tokens refilling at one per second makes every gap legible. */
export const CONTRACT_POLICY: RateLimitPolicy = { capacity: 5, refillPerSecond: 1 }

export type RateLimitStoreContractOptions = {
  /** A store, and a subject nothing else is using. Shared state between cases is how a suite lies. */
  create: () => Promise<{ store: RateLimitStore; subject: () => string }>
}

export const describeRateLimitStoreContract = ({ create }: RateLimitStoreContractOptions): void => {
  describe('the RateLimitStore contract', () => {
    const spend = async (store: RateLimitStore, subject: string, nowMs: number, cost = 1) =>
      store.consume({ subject, cost, nowMs, policy: CONTRACT_POLICY })

    test('a subject nobody has seen starts FULL, not empty', async () => {
      const { store, subject } = await create()
      const decision = await spend(store, subject(), 0)
      expect(decision.allowed).toBe(true)
      // Capacity minus the one just spent. A new key whose first request is refused would
      // be indistinguishable from a broken one.
      expect(decision.remaining).toBe(CONTRACT_POLICY.capacity - 1)
      await store.close()
    })

    test('the burst is exactly `capacity`, and the call after it is refused', async () => {
      const { store, subject } = await create()
      const key = subject()
      // All at the same instant: no refill can hide inside the burst.
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) {
        expect((await spend(store, key, 1_000)).allowed).toBe(true)
      }
      const refused = await spend(store, key, 1_000)
      expect(refused.allowed).toBe(false)
      expect(refused.remaining).toBe(0)
      await store.close()
    })

    test('a refusal costs nothing — a caller cannot dig the hole deeper by retrying', async () => {
      const { store, subject } = await create()
      const key = subject()
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) await spend(store, key, 0)

      const first = await spend(store, key, 0)
      const tenth = await (async () => {
        let last = first
        for (let i = 0; i < 9; i++) last = await spend(store, key, 0)
        return last
      })()
      // Ten refusals at the same instant, and the tenth waits no longer than the first.
      // Deducting on refusal would let a client lock itself out by retrying eagerly.
      expect(tenth.allowed).toBe(false)
      expect(tenth.retryAfterMs).toBe(first.retryAfterMs)
      await store.close()
    })

    test('`retryAfterMs` is honest: waiting exactly that long is enough, and no longer', async () => {
      const { store, subject } = await create()
      const key = subject()
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) await spend(store, key, 0)

      const refused = await spend(store, key, 0)
      expect(refused.allowed).toBe(false)
      expect(refused.retryAfterMs).toBeGreaterThan(0)

      // A millisecond early is still refused — the number is not padded...
      expect((await spend(store, key, refused.retryAfterMs - 1)).allowed).toBe(false)
      // ...and the moment it promises really does work.
      expect((await spend(store, key, refused.retryAfterMs)).allowed).toBe(true)
      await store.close()
    })

    test('refill is continuous, not a window that resets on a boundary', async () => {
      const { store, subject } = await create()
      const key = subject()
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) await spend(store, key, 0)

      // Half the refill interval buys nothing; a whole one buys exactly one token. A fixed
      // window would grant the entire allowance at its boundary instead.
      expect((await spend(store, key, 500)).allowed).toBe(false)
      expect((await spend(store, key, 1_000)).allowed).toBe(true)
      expect((await spend(store, key, 1_000)).allowed).toBe(false)
      await store.close()
    })

    test('refill stops at `capacity` — an idle subject does not bank an allowance', async () => {
      const { store, subject } = await create()
      const key = subject()
      const first = await spend(store, key, 0)
      expect(first.remaining).toBe(CONTRACT_POLICY.capacity - 1)

      // An hour of silence, well past a full bucket. The next burst is `capacity`, not an
      // hour's worth of tokens — which is the difference between a limiter and a savings
      // account.
      const later = 3_600_000
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) {
        expect((await spend(store, key, later)).allowed).toBe(true)
      }
      expect((await spend(store, key, later)).allowed).toBe(false)
      await store.close()
    })

    test('an idle subject past its TTL is indistinguishable from a new one', async () => {
      const { store, subject } = await create()
      const key = subject()
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) await spend(store, key, 0)
      expect((await spend(store, key, 0)).allowed).toBe(false)

      // Forgetting the bucket loses nothing, because by then it would be full anyway. This
      // is what lets the store expire idle subjects rather than grow by one entry per key
      // that ever called us.
      const afterTtl = bucketTtlMs(CONTRACT_POLICY) + 1
      const fresh = await spend(store, key, afterTtl)
      expect(fresh.allowed).toBe(true)
      expect(fresh.remaining).toBe(CONTRACT_POLICY.capacity - 1)
      await store.close()
    })

    test('subjects are independent — one caller cannot spend another’s allowance', async () => {
      const { store, subject } = await create()
      const noisy = subject()
      const quiet = subject()
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) await spend(store, noisy, 0)
      expect((await spend(store, noisy, 0)).allowed).toBe(false)

      const other = await spend(store, quiet, 0)
      expect(other.allowed).toBe(true)
      expect(other.remaining).toBe(CONTRACT_POLICY.capacity - 1)
      await store.close()
    })

    test('`cost` is honoured, so a weighted call is one round trip and not N', async () => {
      const { store, subject } = await create()
      const key = subject()
      const bulk = await spend(store, key, 0, CONTRACT_POLICY.capacity)
      expect(bulk.allowed).toBe(true)
      expect(bulk.remaining).toBe(0)
      expect((await spend(store, key, 0)).allowed).toBe(false)
      await store.close()
    })

    test('a cost larger than the bucket is refused rather than hanging the caller forever', async () => {
      const { store, subject } = await create()
      // Unsatisfiable at any time — the honest answer is "no", not a `Retry-After` that
      // will not be true when it expires.
      const decision = await spend(store, subject(), 0, CONTRACT_POLICY.capacity + 1)
      expect(decision.allowed).toBe(false)
      await store.close()
    })

    test('`resetMs` counts down to a FULL bucket, not to the next single token', async () => {
      const { store, subject } = await create()
      const key = subject()
      const first = await spend(store, key, 0)
      // One token spent, one second per token: the bucket is full again in a second.
      expect(first.resetMs).toBe(1_000)
      const second = await spend(store, key, 0)
      expect(second.resetMs).toBe(2_000)
      await store.close()
    })

    test('a clock that goes backwards mints nothing', async () => {
      const { store, subject } = await create()
      const key = subject()
      for (let i = 0; i < CONTRACT_POLICY.capacity; i++) await spend(store, key, 10_000)
      // NTP steps happen. Time moving backwards should cost the caller nothing — and pay
      // them nothing either.
      expect((await spend(store, key, 5_000)).allowed).toBe(false)
      await store.close()
    })
  })
}
