import { describe, expect, test } from 'bun:test'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { ProviderError } from './provider.port.ts'
import { backoffDelayMs, callWithTimeout, DEFAULT_RETRY_POLICY, retry } from './retry.ts'

/**
 * The retry tests never sleep. `Clock` is injected and jitter is a parameter, so the
 * *schedule* is asserted directly — which is the point of the port (ADR-0012, plan D-H):
 * a backoff nobody can assert on is a backoff nobody has checked.
 */

const policy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 800, timeoutMs: 50 }

const always = (value: number) => () => value

describe('backoff', () => {
  test('doubles per attempt, and stops doubling at the cap', () => {
    const schedule = [0, 1, 2, 3, 4].map((n) => backoffDelayMs(n, policy, always(1)))
    expect(schedule).toEqual([100, 200, 400, 800, 800])
  })

  test('full jitter: the whole interval is randomised, not a fraction of it', () => {
    expect(backoffDelayMs(2, policy, always(0))).toBe(0)
    expect(backoffDelayMs(2, policy, always(0.5))).toBe(200)
    expect(backoffDelayMs(2, policy, always(1))).toBe(400)
  })

  test('never exceeds the cap, whatever the draw', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(backoffDelayMs(attempt, policy, Math.random)).toBeLessThanOrEqual(policy.maxDelayMs)
    }
  })
})

describe('callWithTimeout', () => {
  test('a call that does not answer in time becomes a timeout ProviderError', async () => {
    const hang = callWithTimeout(2, () => new Promise<never>(() => {}))
    await expect(hang).rejects.toBeInstanceOf(ProviderError)
    await expect(hang).rejects.toMatchObject({ kind: 'timeout' })
  })

  test('the deadline aborts the signal, so a listening adapter can stop early', async () => {
    let observed: AbortSignal | undefined
    await callWithTimeout(2, (signal) => {
      observed = signal
      return new Promise<never>(() => {})
    }).catch(() => {})
    expect(observed?.aborted).toBe(true)
  })

  test('a call that answers in time is not disturbed', async () => {
    expect(await callWithTimeout(1_000, async () => 'answered')).toBe('answered')
  })
})

describe('retry', () => {
  test('a first-time success costs one attempt and no waiting', async () => {
    const clock = createFixedClock()
    const result = await retry(async () => 'ok', {
      policy,
      clock,
      isRetryable: () => true,
    })
    expect(result).toEqual({ value: 'ok', attempts: 1 })
    expect(clock.sleeps).toEqual([])
  })

  test('a retryable failure is retried, and the backoff schedule is the one configured', async () => {
    const clock = createFixedClock()
    let calls = 0
    const result = await retry(
      async () => {
        calls += 1
        if (calls < 3) throw new ProviderError('unavailable', 'down')
        return 'ok'
      },
      { policy, clock, random: always(1), isRetryable: () => true },
    )

    expect(result).toEqual({ value: 'ok', attempts: 3 })
    expect(clock.sleeps).toEqual([100, 200])
  })

  test('it gives up after maxAttempts and rethrows the LAST failure', async () => {
    const clock = createFixedClock()
    let calls = 0
    const failing = retry(
      async () => {
        calls += 1
        throw new ProviderError('unavailable', `failure ${calls}`)
      },
      { policy, clock, random: always(1), isRetryable: () => true },
    )

    await expect(failing).rejects.toMatchObject({ message: 'failure 3' })
    expect(calls).toBe(3)
    // Two waits for three attempts: nobody waits after the last one.
    expect(clock.sleeps).toHaveLength(2)
  })

  test('a failure that is not retryable is thrown immediately, uncharged', async () => {
    const clock = createFixedClock()
    let calls = 0
    const failing = retry(
      async () => {
        calls += 1
        throw new ProviderError('invalid_output', 'unusable')
      },
      { policy, clock, isRetryable: () => false },
    )

    await expect(failing).rejects.toMatchObject({ kind: 'invalid_output' })
    expect(calls).toBe(1)
    expect(clock.sleeps).toEqual([])
  })

  test('each attempt gets its own deadline, not one shared across the loop', async () => {
    const clock = createFixedClock()
    let calls = 0
    const failing = retry(
      // Never answers: every attempt has to be ended by its own timeout, or the loop
      // runs once and stops.
      () => {
        calls += 1
        return new Promise<never>(() => {})
      },
      { policy: { ...policy, timeoutMs: 2 }, clock, random: always(0), isRetryable: () => true },
    )

    await expect(failing).rejects.toMatchObject({ kind: 'timeout' })
    expect(calls).toBe(3)
  })
})

describe('the default policy', () => {
  test('the worst case stays inside a latency budget a human is waiting on', () => {
    const { maxAttempts, timeoutMs, baseDelayMs, maxDelayMs } = DEFAULT_RETRY_POLICY
    const worstBackoff = [...Array(maxAttempts - 1).keys()]
      .map((n) => Math.min(baseDelayMs * 2 ** n, maxDelayMs))
      .reduce((a, b) => a + b, 0)
    expect(maxAttempts * timeoutMs + worstBackoff).toBeLessThanOrEqual(31_000)
  })
})
