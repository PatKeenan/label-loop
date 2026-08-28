import type { Clock } from '../ports/clock.ts'
import { ProviderError } from './provider.port.ts'

/**
 * Per-attempt timeout and retry with exponential backoff + jitter — hand-rolled, as a
 * standing principle rather than a one-off (ADR-0012). These primitives are the
 * Category-5 artefact this project exists to demonstrate; importing them would hand away
 * the thing being shown.
 *
 * Timeout and retry live in one file because they are one policy. A retry loop with no
 * per-attempt bound does not retry a hung call — it waits behind it, and the caller sees
 * one slow request instead of three fast ones. A timeout with no retry turns every blip
 * into a customer-visible failure. Neither half is worth much alone.
 */

export type RetryPolicy = {
  /** Total attempts, the first one included. 1 disables retrying. */
  maxAttempts: number
  /** The first backoff, doubled per attempt before jitter. */
  baseDelayMs: number
  /** The ceiling the doubling stops at, so attempt 12 is not a four-hour wait. */
  maxDelayMs: number
  /** How long one attempt may take before it is abandoned. */
  timeoutMs: number
}

/**
 * Conservative on purpose. A judge call sits inside someone else's agent loop, so the
 * worst case a caller can experience — three attempts plus their backoff plus the final
 * timeout — has to stay inside a latency budget a human is waiting on.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  timeoutMs: 10_000,
}

/**
 * **Full** jitter: a uniform draw from `[0, capped)` rather than the capped value itself.
 *
 * The naive schedule retries every failed call at 100ms, then 200ms, then 400ms — so a
 * provider blip synchronises every waiting client into a convoy that arrives together and
 * knocks the provider over again on recovery. Randomising the whole interval, not a
 * fraction of it, is what breaks the convoy; the well-known measurements of this
 * (AWS's "exponential backoff and jitter") find full jitter both settles fastest and
 * costs the fewest total calls.
 *
 * `random` is a parameter, not a call to `Math.random`, because a backoff schedule you
 * cannot assert on is a backoff schedule nobody has checked.
 */
export const backoffDelayMs = (
  attempt: number,
  policy: RetryPolicy,
  random: () => number,
): number => {
  const capped = Math.min(policy.baseDelayMs * 2 ** attempt, policy.maxDelayMs)
  return Math.round(random() * capped)
}

/**
 * Run `work` under a deadline. The signal is passed in so a well-behaved adapter can stop
 * early, and the race is kept anyway so a badly-behaved one cannot outlive its deadline:
 * an unbounded call is exactly what this function exists to make impossible, and trusting
 * the adapter to be well-behaved would make the guarantee advisory.
 *
 * Real timers, deliberately, while retry backoff goes through the injected `Clock`. A
 * timeout races the outside world — the thing the fake `Clock` is not modelling — so
 * driving it from a clock that advances instantly would make every call in every test
 * time out. Timeout tests use single-digit milliseconds instead.
 */
export const callWithTimeout = async <T>(
  timeoutMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new ProviderError('timeout', `the provider did not answer within ${timeoutMs}ms`))
    }, timeoutMs)
  })

  try {
    return await Promise.race([work(controller.signal), deadline])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Frees an adapter still waiting on the signal when the *work* is what settled first.
    controller.abort()
  }
}

export type RetryAttempt = {
  /** 1-based, so a log line reads the way a human counts. */
  attempt: number
  delayMs: number
  error: unknown
}

export type RetryOptions = {
  policy: RetryPolicy
  clock: Clock
  /** Injected jitter. Defaults to the real thing; tests pass a constant. */
  random?: () => number
  /**
   * Whether this failure is worth another call. Not every one is: an unusable answer is a
   * rubric problem, and asking the identical question again produces the identical
   * unusable answer while charging for it twice.
   */
  isRetryable: (error: unknown) => boolean
  /** Observation only — the retry decision is made above, not here. */
  onRetry?: (attempt: RetryAttempt) => void
}

/** How many times `work` ran. Attached to every verdict, so retry flakiness is visible. */
export type RetryResult<T> = { value: T; attempts: number }

export const retry = async <T>(
  work: (signal: AbortSignal) => Promise<T>,
  { policy, clock, random = Math.random, isRetryable, onRetry }: RetryOptions,
): Promise<RetryResult<T>> => {
  let lastError: unknown

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return { value: await callWithTimeout(policy.timeoutMs, work), attempts: attempt }
    } catch (error) {
      lastError = error
      const isLast = attempt === policy.maxAttempts
      if (isLast || !isRetryable(error)) break

      const delayMs = backoffDelayMs(attempt - 1, policy, random)
      onRetry?.({ attempt, delayMs, error })
      await clock.sleep(delayMs)
    }
  }

  throw lastError
}
