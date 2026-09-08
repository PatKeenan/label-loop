import type { RateLimitDecision, RateLimitStore } from '../ports/rate-limit-store.ts'
import { bucketTtlMs } from './token-bucket.ts'

/**
 * The real counter store, on **Bun's built-in `Bun.RedisClient`** — so Redis adds no npm
 * dependency (ADR-0039). Judged the way CONVENTIONS asks, by what a package would REPLACE:
 * the built-in replaces `ioredis` or `node-redis` entirely, so the package would buy
 * nothing. This is a runtime capability, not a resilience library, and importing it hands
 * away no behaviour ADR-0012 is about — the bucket is still ours, in `token-bucket.ts`.
 *
 * **The whole bucket is one Lua script**, and that is the only reason this file exists.
 * Read-then-write across two commands is a race: two requests for the same key read the
 * same token count, both decide they may proceed, and the limit is quietly twice what it
 * says. It shows up under exactly the concurrency M2 exists to generate, which is the worst
 * possible time to discover it. `EVAL` runs the read, the arithmetic and the write inside
 * one Redis execution, and atomicity is a property of the store rather than behaviour a
 * hand-rolled limiter could get right on its own.
 */

/**
 * The bucket, in Lua — a transcription of `consume()` in `token-bucket.ts`, which is the
 * specification. Any change to the arithmetic there belongs here in the same commit, and
 * `store.contract-test.ts` is what fails when one of the two is forgotten.
 *
 * Returned as four integers rather than a table of strings: Redis's Lua-to-RESP conversion
 * truncates floats silently, so anything fractional is rounded HERE, deliberately, rather
 * than being mangled on the way out.
 */
const CONSUME = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local refill = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local stored = redis.call('HMGET', key, 't', 'u')
local tokens = tonumber(stored[1])
local updated = tonumber(stored[2])
-- An absent bucket is a FULL one, and so is an expired one. Identical on purpose: it is
-- what lets Redis forget idle subjects instead of remembering every key forever.
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now
end

-- Clamped, because a clock that went backwards must not mint tokens.
local elapsed = now - updated
if elapsed < 0 then elapsed = 0 end
tokens = math.min(capacity, tokens + (elapsed / 1000) * refill)

local allowed = 0
if tokens >= cost then
  allowed = 1
  tokens = tokens - cost
end

-- Written whether or not the call was allowed: 'u' records when 't' was last correct, and
-- freezing it on refusal would replay the same gap and refill twice.
redis.call('HSET', key, 't', tokens, 'u', now)
redis.call('PEXPIRE', key, ttl)

local retryAfter = 0
if allowed == 0 then
  retryAfter = math.ceil(((cost - tokens) / refill) * 1000)
end
local reset = math.ceil(((capacity - tokens) / refill) * 1000)

return { allowed, math.floor(tokens), retryAfter, reset }
`

export type RedisRateLimitStoreOptions = {
  url: string
  /**
   * Namespace for every key this store writes. Explicit rather than bare, because this
   * Redis may one day hold something else, and a limiter that can collide with another
   * feature's keys is a limiter that fails in a way nobody will attribute to it.
   */
  keyPrefix?: string
  /**
   * How long one `EVAL` may take before the store gives up on it.
   *
   * **This is what makes ADR-0040's fail-open reachable at all**, and it is not optional
   * decoration. Without a deadline an unreachable Redis does not throw — the client queues
   * the command and waits for a reconnection that may never come — so the middleware's
   * `catch` never runs and the request hangs instead of being served. A limiter that turns
   * a Redis outage into hung requests is strictly worse than no limiter, which is the
   * failure this bounds.
   *
   * The deadline covers a hung-but-connected Redis for free, which is why it is one
   * mechanism rather than a connect timeout plus a command timeout.
   *
   * 250ms because this sits in front of a judge call measured in SECONDS (`llm/retry.ts`'s
   * table): a quarter second is invisible against that budget, and generous by two orders
   * of magnitude against a local Redis round trip.
   */
  commandTimeoutMs?: number
}

/**
 * Race `work` against a deadline. Written here rather than reused from `llm/retry.ts`
 * because that helper hands its work an `AbortSignal` — and `Bun.RedisClient` takes none,
 * so the losing command genuinely keeps running. It is left with a no-op catch attached:
 * it will settle eventually against a reconnected client, and an unobserved rejection
 * would otherwise surface as a process-level unhandled rejection during an outage.
 */
const withDeadline = async <T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`redis ${what} did not answer within ${timeoutMs}ms`)),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    void work.catch(() => {})
  }
}

/** How often a dead client may be replaced. One burst during an outage, one attempt. */
const REBUILD_INTERVAL_MS = 1_000

/**
 * A number the Lua script returned. Redis hands these back as JS numbers, but the client's
 * return type is deliberately wide — an `eval` may return anything at all — so the shape
 * is checked rather than asserted. A store that quietly answered `NaN` would fail OPEN
 * without ever logging why, which is the one failure mode ADR-0040 cannot tolerate.
 */
const asNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'string' ? Number(value) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new TypeError(`the rate-limit script returned a non-numeric ${field}: ${String(value)}`)
  }
  return parsed
}

export const createRedisRateLimitStore = ({
  url,
  keyPrefix = 'ratelimit:',
  commandTimeoutMs = 250,
}: RedisRateLimitStoreOptions): RateLimitStore => {
  /**
   * **The client is rebuilt when it dies, and that is a workaround for a real defect
   * rather than defensive decoration.**
   *
   * Bun's `RedisClient` reconnects a few times after a dropped connection and then enters a
   * TERMINAL state: every later command fails with "Connection has failed" and it never
   * tries again. Raising `maxRetries` helps in the simple case and did NOT hold here —
   * measured against the composed stack on 2026-09-04, a `docker compose stop redis` /
   * `start redis` left the API failing open indefinitely, on a client configured for two
   * billion retries, until the process was restarted. (A restarted container also comes
   * back on a fresh address, which a client holding a resolved one would never find.)
   *
   * Left alone, that turns ADR-0040's fail-open from a brief degradation into a permanent
   * one: a ten-second Redis restart and the rate limiter is off until someone redeploys.
   * So the store owns its own recovery — a dead client is discarded and the next request
   * builds a new one, which re-resolves the hostname and reconnects.
   *
   * Rebuilding is rate-limited to once a second so a burst arriving during an outage shares
   * one attempt rather than opening and closing a socket per request.
   */
  const connect = (): Bun.RedisClient =>
    new Bun.RedisClient(url, {
      autoReconnect: true,
      // Generous, so ordinary blips are handled by the client itself and the rebuild below
      // is the backstop rather than the mechanism.
      maxRetries: 2_000_000_000,
      connectionTimeout: 500,
    })

  let client = connect()
  let builtAtMs = Number.NEGATIVE_INFINITY

  /** Throw away a client that has stopped trying, so the next call gets a fresh one. */
  const discardIfDead = (nowMs: number): void => {
    if (client.connected) return
    if (nowMs - builtAtMs < REBUILD_INTERVAL_MS) return
    // Order matters: close the old socket before opening another, or an outage leaks one
    // connection per second for as long as it lasts.
    client.close()
    client = connect()
    builtAtMs = nowMs
  }

  return {
    consume: async ({ subject, cost, nowMs, policy }): Promise<RateLimitDecision> => {
      const returned: unknown = await withDeadline(
        // Read once: `client` may be replaced between the call and its rejection.
        client.eval(
          CONSUME,
          // One KEY, then five ARGV. Bun types the key count as a number and everything
          // after it as strings, which is Redis's own EVAL shape.
          1,
          `${keyPrefix}${subject}`,
          String(nowMs),
          String(policy.capacity),
          String(policy.refillPerSecond),
          String(cost),
          String(bucketTtlMs(policy)),
        ),
        commandTimeoutMs,
        'consume',
      ).catch((error: unknown) => {
        discardIfDead(nowMs)
        throw error
      })

      if (!Array.isArray(returned) || returned.length !== 4) {
        throw new TypeError(
          `the rate-limit script returned ${JSON.stringify(returned)}, expected four values`,
        )
      }

      return {
        allowed: asNumber(returned[0], 'allowed') === 1,
        remaining: asNumber(returned[1], 'remaining'),
        retryAfterMs: asNumber(returned[2], 'retryAfterMs'),
        resetMs: asNumber(returned[3], 'resetMs'),
      }
    },

    close: async () => {
      client.close()
    },
  }
}
