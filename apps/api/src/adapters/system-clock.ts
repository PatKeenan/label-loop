import type { Clock } from '../ports/clock.ts'

/** The real clock. Wired in `server.ts`; never in tests. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}
