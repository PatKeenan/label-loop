import type { Clock } from '../ports/clock.ts'

/**
 * A circuit breaker, hand-rolled (ADR-0012).
 *
 * Retry answers "was that a blip?". The breaker answers the question retry cannot: "is
 * this thing down?" — because retrying into an outage is how a dependency's bad minute
 * becomes our bad hour. Once a provider has failed repeatedly, further calls are refused
 * *without* being made, which fails the caller in milliseconds instead of after three
 * timeouts, and stops us adding load to something already struggling.
 *
 * Three states, and the middle one is the whole design:
 *   closed    — calls pass through; consecutive failures are counted.
 *   open      — calls are refused outright until the cooldown elapses.
 *   half-open — exactly ONE call is let through as a probe. It closes the breaker if it
 *               succeeds and re-opens it if it does not. Without this state, recovery is
 *               either a guess or a stampede.
 */

export type BreakerState = 'closed' | 'open' | 'half_open'

export type BreakerPolicy = {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number
  /** How long it stays open before a probe is allowed through. */
  openMs: number
}

export const DEFAULT_BREAKER_POLICY: BreakerPolicy = {
  failureThreshold: 5,
  openMs: 30_000,
}

/**
 * Thrown *instead of* calling the provider. It is not a provider failure — no provider
 * was involved — which is why it is its own type and maps to its own code
 * (`CIRCUIT_OPEN`, 503) rather than being folded into `PROVIDER_UNAVAILABLE`. A caller
 * that cannot tell the two apart cannot tell "the provider is broken" from "we have
 * stopped asking it", and only the second one has a knowable end time.
 */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError'
  /** How long until the next probe. Becomes the response's `Retry-After`. */
  readonly retryAfterMs: number

  constructor(key: string, retryAfterMs: number) {
    super(`the circuit for ${key} is open`)
    this.retryAfterMs = retryAfterMs
  }
}

export type BreakerOptions = {
  /** Named in logs and in the error; one breaker per model, so this is the model id. */
  key: string
  clock: Clock
  policy?: BreakerPolicy
  /**
   * Whether a failure says anything about the dependency's HEALTH. Not every one does: an
   * unusable answer means the rubric is wrong, and tripping the breaker on it would take
   * a working provider out of service because of a badly written judge.
   */
  counts?: (error: unknown) => boolean
  onStateChange?: (change: { key: string; from: BreakerState; to: BreakerState }) => void
}

export type Breaker = {
  readonly key: string
  readonly state: BreakerState
  /** Run under the breaker. Throws `CircuitOpenError` without calling `work` when open. */
  run: <T>(work: () => Promise<T>) => Promise<T>
}

export const createBreaker = ({
  key,
  clock,
  policy = DEFAULT_BREAKER_POLICY,
  counts = () => true,
  onStateChange,
}: BreakerOptions): Breaker => {
  let state: BreakerState = 'closed'
  let consecutiveFailures = 0
  let openedAt = 0
  // Judges fan out in parallel, so several calls can reach a cooled-down breaker in the
  // same millisecond. Without this, "exactly one probe" would silently become "as many
  // probes as there are judges" — a stampede at precisely the worst moment.
  let probing = false

  const transition = (to: BreakerState): void => {
    if (state === to) return
    const from = state
    state = to
    onStateChange?.({ key, from, to })
  }

  const open = (): void => {
    openedAt = clock.now()
    transition('open')
  }

  const remainingMs = (): number => Math.max(0, policy.openMs - (clock.now() - openedAt))

  return {
    key,

    get state() {
      return state
    },

    run: async <T>(work: () => Promise<T>): Promise<T> => {
      if (state === 'open') {
        const remaining = remainingMs()
        if (remaining > 0) throw new CircuitOpenError(key, remaining)
        transition('half_open')
      }

      if (state === 'half_open' && probing) {
        throw new CircuitOpenError(key, policy.openMs)
      }

      const isProbe = state === 'half_open'
      if (isProbe) probing = true

      try {
        const value = await work()
        consecutiveFailures = 0
        transition('closed')
        return value
      } catch (error) {
        if (!counts(error)) throw error
        if (isProbe) {
          // One failed probe re-opens immediately: the cooldown just proved insufficient,
          // and counting up to the threshold again would mean N more calls into an outage.
          open()
          throw error
        }
        consecutiveFailures += 1
        if (consecutiveFailures >= policy.failureThreshold) open()
        throw error
      } finally {
        if (isProbe) probing = false
      }
    },
  }
}

/**
 * One breaker per model, created on demand.
 *
 * Per model rather than per process because a panel's judges may run on different models,
 * and one bad model must not take the working ones out of service with it — which is
 * exactly what a single global breaker would do the moment M7's multi-provider routing
 * lands.
 */
export const createBreakerRegistry = (defaults: Omit<BreakerOptions, 'key'>) => {
  const breakers = new Map<string, Breaker>()
  return {
    for: (key: string): Breaker => {
      const existing = breakers.get(key)
      if (existing !== undefined) return existing
      const breaker = createBreaker({ ...defaults, key })
      breakers.set(key, breaker)
      return breaker
    },
  }
}

export type BreakerRegistry = ReturnType<typeof createBreakerRegistry>
