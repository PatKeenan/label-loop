/**
 * Port #2 (CONVENTIONS.md "Dependency seams"). Time is an external effect: code that
 * reads the wall clock directly cannot be tested without sleeping, and tests that sleep
 * are slow and flaky. P4's retry backoff and circuit breaker depend on this being here.
 */
export type Clock = {
  /** Milliseconds since the epoch. */
  now: () => number
  /** Resolves after `ms`. Injected so retry/breaker tests never actually wait. */
  sleep: (ms: number) => Promise<void>
}
