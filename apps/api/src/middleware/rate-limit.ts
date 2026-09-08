import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'
import type { RateLimitPolicy } from '../ports/rate-limit-store.ts'
import { createTokenBucket, DEFAULT_RATE_LIMIT } from '../rate-limit/token-bucket.ts'

/**
 * Per-key rate limiting (SENIORITY_CHECKLIST 5, ADR-0038/0039/0040).
 *
 * Three things are true of this middleware, and the second and third are the ones worth
 * reading twice.
 *
 * 1. **It throws; it never builds a response.** `RATE_LIMITED` already exists in the
 *    closed taxonomy at 429 with `retryAfter: true`, and `app.ts`'s single handler reads
 *    that spec to set the header. No new error code was needed for this phase — if one had
 *    been reached for, the design had drifted.
 * 2. **It runs AFTER authentication, and that order is tested.** Limiting first would mean
 *    an anonymous flood — anyone, no key, guessing at a panel id — consuming a real
 *    customer's allowance, which turns the limiter into the denial of service it exists to
 *    prevent.
 * 3. **It FAILS OPEN** (ADR-0040). A store error serves the request rather than refusing
 *    it: a limiter outage becoming a service outage is a worse failure than a brief window
 *    of unlimited traffic, and graceful degradation is the whole subject of M2. The cost is
 *    real and recorded rather than waved away — during a Redis outage there is no bound on
 *    traffic at all — and it is acceptable only because this limit is about throughput
 *    fairness rather than about spend. **M8's per-org `QUOTA_EXCEEDED` is load-bearing for
 *    money and must revisit this rather than inherit it.**
 */

/** What the caller is told. It says what to do, and nothing about who else is loud. */
const RATE_LIMITED =
  'Too many requests for this API key. Retry after the number of seconds in Retry-After.'

export type RateLimitOptions = {
  /**
   * Who is being limited, read from the request.
   *
   * A parameter rather than a hardcoded key id, deliberately: per-org quota at M8 is then a
   * different call site rather than a refactor of this file, and the same middleware can
   * limit two different things on two different routes without either learning about the
   * other. Returning `undefined` means "not a subject" and skips the check — which is what
   * keeps this honest about running behind authentication rather than pretending to work
   * without it.
   */
  subject: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string | undefined
  policy?: RateLimitPolicy
  /** Tokens one request costs. One today; the seam M8's weighted metering needs. */
  cost?: number
}

/** The subject for `/v1`: the key that authorised the request. Set by `apiKeyAuth`. */
export const byApiKey = (c: Parameters<MiddlewareHandler<AppEnv>>[0]): string | undefined => {
  // `c.get` on an unset variable is `undefined` at runtime whatever the type says, and
  // that is exactly the unauthenticated case: no key, no subject, nothing consumed.
  const key = c.get('apiKey') as AppEnv['Variables']['apiKey'] | undefined
  return key?.id === undefined ? undefined : `key:${key.id}`
}

export const rateLimit = ({
  subject,
  policy = DEFAULT_RATE_LIMIT,
  cost = 1,
}: RateLimitOptions): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const who = subject(c)
    // No subject is not a failure and not a free pass either — it means this request never
    // reached the middleware that identifies one, and `apiKeyAuth` has already turned it
    // away. Consuming an anonymous request's tokens would require inventing a subject, and
    // every invented subject is either shared (one flood limits everyone) or per-request
    // (limits nobody).
    if (who === undefined) return await next()

    const bucket = createTokenBucket({
      store: c.var.deps.rateLimitStore,
      clock: c.var.deps.clock,
      policy,
    })

    let decision: Awaited<ReturnType<typeof bucket.consume>>
    try {
      decision = await bucket.consume(who, cost)
    } catch (error) {
      // ADR-0040, and the half of it that is not the decision itself: a fail-open limiter
      // is INVISIBLE when it breaks, so the warning and the report are what make the outage
      // findable. `warn` rather than `error` because the service is degraded and still
      // serving, which is precisely what that level means (CONVENTIONS.md "Logging").
      c.var.logger.warn(
        { subject: who, err: error },
        'rate-limit store unavailable, failing open — traffic is UNLIMITED until it recovers',
      )
      c.var.deps.errorReporter.report(error, {
        requestId: c.var.requestId,
        context: { component: 'rate-limit', subject: who },
      })
      return await next()
    }

    if (!decision.allowed) {
      throw new AppError('RATE_LIMITED', RATE_LIMITED, {
        // Computed from the bucket, never a constant: a constant either sends the caller
        // back before there is a token for them or makes them wait longer than they must.
        // Rounded UP for the first of those reasons — `Retry-After` is whole seconds, and a
        // 600ms wait expressed as 0 is an invitation to hammer.
        retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1_000)),
        context: { subject: who, capacity: policy.capacity },
      })
    }

    await next()
  }
}
