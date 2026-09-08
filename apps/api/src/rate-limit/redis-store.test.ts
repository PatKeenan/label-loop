import { describe, expect, test } from 'bun:test'
import { createRedisRateLimitStore } from './redis-store.ts'
import { CONTRACT_POLICY, describeRateLimitStoreContract } from './store.contract-test.ts'

/**
 * The real adapter, against a real Redis — and deliberately NOT skipped when there is none,
 * for the same reason the database tests are not (`.github/workflows/ci.yml` says it in
 * full): the claims here are about what REDIS does with a Lua script under concurrency, and
 * a test that silently skips reads green in CI while proving nothing. The Lua is a second
 * transcription of `token-bucket.ts`'s arithmetic, so this file is the only place the two
 * are ever compared.
 */
const REDIS_URL = (() => {
  const url = process.env.REDIS_URL
  if (url === undefined || url === '') {
    throw new Error(
      'REDIS_URL is not set — the rate-limit store tests need a running Redis.\n' +
        'Run: docker compose -f infra/docker-compose.yml up -d --wait redis   ' +
        '(or copy .env.example to .env)',
    )
  }
  return url
})()

/** A namespace per run, so a re-run never inherits the last one's buckets. */
const RUN = Math.random().toString(36).slice(2, 10)
let counter = 0
const nextSubject = (): string => {
  counter += 1
  return `${RUN}-${counter}`
}

describeRateLimitStoreContract({
  create: async () => ({
    store: createRedisRateLimitStore({ url: REDIS_URL, keyPrefix: 'ratelimit-test:' }),
    subject: nextSubject,
  }),
})

describe('the Redis store, beyond the shared contract', () => {
  test('consumes atomically — a concurrent burst spends each token exactly once', async () => {
    // THE reason this adapter is a Lua script rather than a read and a write. Fired
    // together with no `await` between them, so they are genuinely in flight at once: under
    // read-then-write, several of these would read the same token count and all decide they
    // may proceed, and the limit would quietly be more than it says. That race is invisible
    // in a sequential test and appears under exactly the load M2 exists to generate.
    const store = createRedisRateLimitStore({ url: REDIS_URL, keyPrefix: 'ratelimit-test:' })
    const subject = nextSubject()
    const burst = CONTRACT_POLICY.capacity * 4

    const decisions = await Promise.all(
      Array.from({ length: burst }, () =>
        store.consume({ subject, cost: 1, nowMs: 1_000, policy: CONTRACT_POLICY }),
      ),
    )

    // Frozen `nowMs`, so no token can refill mid-burst: exactly `capacity` may pass.
    expect(decisions.filter((decision) => decision.allowed).length).toBe(CONTRACT_POLICY.capacity)
    await store.close()
  })

  test('an unreachable Redis REJECTS, promptly, rather than hanging the request', async () => {
    // The claim that makes ADR-0040's fail-open reachable. Bun's client queues a command
    // issued while disconnected and waits for a reconnection that, against a port nothing
    // listens on, never arrives — so without the adapter's deadline this call never settles,
    // the middleware's `catch` never runs, and a Redis outage becomes hung requests instead
    // of served ones. Asserted with a real clock because the deadline races the real world.
    const store = createRedisRateLimitStore({ url: 'redis://127.0.0.1:1', commandTimeoutMs: 100 })
    const startedAt = Bun.nanoseconds()
    const outcome = await store
      .consume({ subject: 'unreachable', cost: 1, nowMs: 0, policy: CONTRACT_POLICY })
      .then(
        () => 'resolved',
        () => 'rejected',
      )
    const elapsedMs = (Bun.nanoseconds() - startedAt) / 1_000_000

    expect(outcome).toBe('rejected')
    // Generously bounded — the assertion is "fast enough to be invisible", not a benchmark.
    expect(elapsedMs).toBeLessThan(2_000)

    // And the store does not fail open on its own: serving the request anyway is a POLICY
    // (ADR-0040) that lives in the middleware, where it can be logged and reported. A store
    // that swallowed this would make the outage invisible.
    await store.close()
  })
})

describe('recovery, because a limiter that never comes back is worse than none', () => {
  test('keeps reconnecting rather than giving up permanently after a blip', async () => {
    // A regression guard for a REAL failure found by hand on 2026-09-04: with Bun's default
    // `maxRetries`, a Redis restart put the client into a terminal "Connection has failed"
    // state and the limiter stayed off until the process was restarted. Fail-open is meant
    // to be a brief degradation, not a permanent one.
    //
    // Asserted through the port rather than by cycling a container: the claim is that the
    // adapter is configured not to give up, and a store still answering after far more
    // failures than the old ceiling allowed is what shows it has not.
    const store = createRedisRateLimitStore({
      url: 'redis://127.0.0.1:1',
      commandTimeoutMs: 25,
    })
    for (let i = 0; i < 15; i++) {
      const outcome = await store
        .consume({ subject: 'flapping', cost: 1, nowMs: 0, policy: CONTRACT_POLICY })
        .then(
          () => 'resolved',
          (error: unknown) => (error as Error).message,
        )
      expect(outcome).not.toBe('resolved')
      // The terminal state, by name. Reaching it means the client has stopped trying.
      expect(outcome).not.toContain('Connection has failed')
    }
    await store.close()
  })
})
