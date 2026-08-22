import type { Clock } from '../ports/clock.ts'

export type FixedClock = Clock & {
  /** Move time forward without waiting. */
  advance: (ms: number) => void
  /** Every duration `sleep` was asked to wait, in order — the assertion surface for backoff. */
  readonly sleeps: readonly number[]
}

/**
 * A deterministic clock for tests. `sleep` records the requested delay and advances time
 * instantly, so a test can assert the *shape* of a backoff schedule in microseconds.
 */
export const createFixedClock = (startMs = 0): FixedClock => {
  let current = startMs
  const sleeps: number[] = []
  return {
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms)
      current += ms
    },
    advance: (ms) => {
      current += ms
    },
    sleeps,
  }
}
