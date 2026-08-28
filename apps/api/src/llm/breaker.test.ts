import { describe, expect, test } from 'bun:test'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import {
  type BreakerState,
  CircuitOpenError,
  createBreaker,
  createBreakerRegistry,
} from './breaker.ts'

const policy = { failureThreshold: 3, openMs: 1_000 }

const boom = () => Promise.reject(new Error('provider is down'))
const fine = () => Promise.resolve('answered')

const swallow = async (work: Promise<unknown>): Promise<unknown> => work.catch((e: unknown) => e)

const failTimes = async (
  breaker: { run: <T>(w: () => Promise<T>) => Promise<T> },
  times: number,
) => {
  for (let i = 0; i < times; i++) await swallow(breaker.run(boom))
}

describe('closing and opening', () => {
  test('failures below the threshold leave the circuit closed', async () => {
    const breaker = createBreaker({ key: 'm', clock: createFixedClock(), policy })
    await failTimes(breaker, 2)
    expect(breaker.state).toBe('closed')
  })

  test('the threshold opens it, and the next call is refused WITHOUT being made', async () => {
    const breaker = createBreaker({ key: 'm', clock: createFixedClock(), policy })
    await failTimes(breaker, 3)
    expect(breaker.state).toBe('open')

    let called = false
    const refused = await swallow(
      breaker.run(async () => {
        called = true
        return 'answered'
      }),
    )
    expect(called).toBe(false)
    expect(refused).toBeInstanceOf(CircuitOpenError)
  })

  test('the refusal says how long is left, so a caller gets an honest Retry-After', async () => {
    const clock = createFixedClock()
    const breaker = createBreaker({ key: 'm', clock, policy })
    await failTimes(breaker, 3)
    clock.advance(400)
    const refused = await swallow(breaker.run(fine))
    expect((refused as CircuitOpenError).retryAfterMs).toBe(600)
  })

  test('the failure count is CONSECUTIVE — a success in between resets it', async () => {
    const breaker = createBreaker({ key: 'm', clock: createFixedClock(), policy })
    await failTimes(breaker, 2)
    await breaker.run(fine)
    await failTimes(breaker, 2)
    expect(breaker.state).toBe('closed')
  })
})

describe('recovery', () => {
  test('after the cooldown ONE probe is let through, and success closes the circuit', async () => {
    const clock = createFixedClock()
    const breaker = createBreaker({ key: 'm', clock, policy })
    await failTimes(breaker, 3)

    clock.advance(policy.openMs)
    expect(await breaker.run(fine)).toBe('answered')
    expect(breaker.state).toBe('closed')
  })

  test('a failed probe re-opens immediately rather than counting up again', async () => {
    const clock = createFixedClock()
    const breaker = createBreaker({ key: 'm', clock, policy })
    await failTimes(breaker, 3)

    clock.advance(policy.openMs)
    await swallow(breaker.run(boom))
    expect(breaker.state).toBe('open')

    let called = false
    await swallow(
      breaker.run(async () => {
        called = true
        return 'answered'
      }),
    )
    expect(called).toBe(false)
  })

  test('exactly one probe: judges fan out in parallel, and only one may through', async () => {
    const clock = createFixedClock()
    const breaker = createBreaker({ key: 'm', clock, policy })
    await failTimes(breaker, 3)
    clock.advance(policy.openMs)

    let entered = 0
    let release = () => {}
    const gate = new Promise<string>((resolve) => {
      release = () => resolve('answered')
    })
    const probe = async () => {
      entered += 1
      return gate
    }

    const first = breaker.run(probe)
    const second = await swallow(breaker.run(probe))
    release()
    await first

    expect(entered).toBe(1)
    expect(second).toBeInstanceOf(CircuitOpenError)
  })
})

describe('what counts as a failure', () => {
  test('an error the policy does not count never opens the circuit', async () => {
    const breaker = createBreaker({
      key: 'm',
      clock: createFixedClock(),
      policy,
      // Stands in for `invalid_output`: a badly written judge must not take a working
      // provider out of service.
      counts: () => false,
    })
    await failTimes(breaker, 10)
    expect(breaker.state).toBe('closed')
  })
})

describe('state changes are observable', () => {
  test('every transition is announced once, in order', async () => {
    const clock = createFixedClock()
    const changes: Array<`${BreakerState}->${BreakerState}`> = []
    const breaker = createBreaker({
      key: 'm',
      clock,
      policy,
      onStateChange: ({ from, to }) => changes.push(`${from}->${to}`),
    })

    await failTimes(breaker, 3)
    clock.advance(policy.openMs)
    await breaker.run(fine)

    expect(changes).toEqual(['closed->open', 'open->half_open', 'half_open->closed'])
  })
})

describe('the registry', () => {
  test('one breaker per model: a broken model does not take a working one down', async () => {
    const registry = createBreakerRegistry({ clock: createFixedClock(), policy })
    await failTimes(registry.for('broken'), 3)

    expect(registry.for('broken').state).toBe('open')
    expect(registry.for('working').state).toBe('closed')
    expect(await registry.for('working').run(fine)).toBe('answered')
  })

  test('the same key is the same breaker, not a fresh one per call', async () => {
    const registry = createBreakerRegistry({ clock: createFixedClock(), policy })
    for (let i = 0; i < 3; i++) await swallow(registry.for('m').run(boom))
    expect(registry.for('m').state).toBe('open')
  })
})
