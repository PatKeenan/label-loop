/**
 * Port #4 (CONVENTIONS.md "Dependency seams"). The counter store behind per-key rate
 * limiting — and *only* the counter store: the token bucket itself is hand-rolled in
 * `rate-limit/token-bucket.ts`, because that algorithm is one of the Category-5 artefacts
 * this project exists to demonstrate (ADR-0012, ADR-0039).
 *
 * What is genuinely delegated here is the pair of things a limiter cannot fake: state that
 * outlives one process, and an ATOMIC read-modify-write over it. Two commands — read the
 * bucket, then write it back — is a race that shows up under exactly the load M2 exists to
 * generate, so the port's one method is "consume and tell me what happened", never
 * "read" plus "write".
 *
 * The store was chosen ahead of the evidence that would justify it (ADR-0038), which is
 * precisely why it is a port: if `docs/BREAKING_POINT.md` says a single instance never
 * needed Redis, the reversal is one adapter file.
 */

export type RateLimitPolicy = {
  /** Maximum tokens the bucket holds — the burst one subject may spend at once. */
  capacity: number
  /** Tokens added per second. Sustained throughput, once the burst is gone. */
  refillPerSecond: number
}

export type RateLimitDecision = {
  allowed: boolean
  /** Whole tokens left after this call. Fractional tokens cannot serve a whole request. */
  remaining: number
  /**
   * How long until the bucket holds enough tokens for THIS call. Zero when allowed, and
   * what the 429's `Retry-After` is computed from — never a constant, because a constant
   * either sends the caller back too early or makes them wait longer than they must.
   */
  retryAfterMs: number
  /** How long until the bucket is full again. The `X-RateLimit-Reset` sense of "reset". */
  resetMs: number
}

export type RateLimitRequest = {
  /**
   * What is being limited. A key id today; parameterised rather than assumed so M8's
   * per-org quota is a different call site instead of a refactor of this port.
   */
  subject: string
  /** Tokens this call costs. One per request today; the parameter is what makes weighting possible. */
  cost: number
  /**
   * Now, from the injected `Clock` rather than from the store's own host.
   *
   * The trade is worth naming: Redis's `TIME` would be one authoritative clock across
   * every API instance, while this trusts each instance's own. Skew between instances
   * therefore smears a bucket's refill by however far their clocks differ — bounded by NTP
   * to milliseconds, against a window measured in seconds. What it buys is that the fake
   * and the real adapter are driven by the SAME time source, so both can pass one contract
   * suite without either sleeping.
   */
  nowMs: number
  policy: RateLimitPolicy
}

export type RateLimitStore = {
  /** Consume `cost` tokens for `subject`, atomically, and say what the bucket now looks like. */
  consume: (request: RateLimitRequest) => Promise<RateLimitDecision>
  /** Release whatever the adapter holds open. The in-memory fake has nothing to release. */
  close: () => Promise<void>
}
