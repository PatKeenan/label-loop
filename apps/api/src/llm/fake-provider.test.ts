import { describe, expect, test } from 'bun:test'
import {
  createFakeProvider,
  FAKE_MODEL,
  FAKE_SENTINELS,
  MEASURED_JUDGE_LATENCY,
} from './fake-provider.ts'
import { describeModelProviderContract, expectProviderFailure } from './provider.contract-test.ts'

/**
 * The fake is held to the port's shared contract first, and only then to the promises
 * that are its own — determinism and the sentinels. The split matters: everything in the
 * suite below the contract call is a property M1's real adapter is NOT expected to have.
 */
describeModelProviderContract({
  create: () => createFakeProvider(),
  model: FAKE_MODEL,
  unknownModel: 'anthropic:claude-sonnet-4-5',
})

const call = {
  model: FAKE_MODEL,
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17.',
  context: { source: 'github' },
}

describe('determinism', () => {
  test('the same call answers identically, across separate adapter instances', async () => {
    const first = await createFakeProvider().evaluate(call)
    const second = await createFakeProvider().evaluate(call)
    expect(second).toEqual(first)
  })

  test('context key order is not part of the input', async () => {
    const a = await createFakeProvider().evaluate({ ...call, context: { x: '1', y: '2' } })
    const b = await createFakeProvider().evaluate({ ...call, context: { y: '2', x: '1' } })
    expect(b.output).toEqual(a.output)
  })

  test('a different artifact is a different call', async () => {
    const a = await createFakeProvider().evaluate(call)
    const b = await createFakeProvider().evaluate({ ...call, artifact: 'something else' })
    expect(b.raw).not.toEqual(a.raw)
  })

  test('verdicts are not all the same value — a constant would prove nothing', async () => {
    const provider = createFakeProvider()
    const verdicts = new Set<boolean>()
    for (let i = 0; i < 20; i++) {
      const result = await provider.evaluate({ ...call, artifact: `artifact ${i}` })
      verdicts.add(result.output.verdict)
    }
    expect(verdicts.size).toBe(2)
  })

  test('reasons are present exactly when the verdict is true', async () => {
    const provider = createFakeProvider()
    for (let i = 0; i < 10; i++) {
      const { output } = await provider.evaluate({ ...call, artifact: `artifact ${i}` })
      expect(output.reasons.length > 0).toBe(output.verdict)
    }
  })
})

describe('the failure knobs', () => {
  test('failFirst fails exactly that many calls, then answers', async () => {
    const provider = createFakeProvider({ failFirst: 2 })
    await expect(provider.evaluate(call)).rejects.toThrow()
    await expect(provider.evaluate(call)).rejects.toThrow()
    expect((await provider.evaluate(call)).output.verdict).toBeBoolean()
    expect(provider.calls).toBe(3)
  })

  test.each([
    [FAKE_SENTINELS.unavailable, 'unavailable'],
    [FAKE_SENTINELS.invalidOutput, 'invalid_output'],
  ] as const)('the %s sentinel fails as %s', async (sentinel, kind) => {
    await expectProviderFailure(
      createFakeProvider().evaluate({ ...call, artifact: `${sentinel} broken` }),
      kind,
    )
  })

  test('the slow sentinel does not settle until something aborts it', async () => {
    const controller = new AbortController()
    const pending = createFakeProvider().evaluate({
      ...call,
      artifact: `${FAKE_SENTINELS.slow} hangs`,
      signal: controller.signal,
    })
    // A tick with nothing else queued: if the call were going to settle on its own, it
    // already would have.
    const settledEarly = await Promise.race([
      pending.then(
        () => true,
        () => true,
      ),
      Promise.resolve(false),
    ])
    expect(settledEarly).toBe(false)

    controller.abort()
    await expectProviderFailure(pending, 'timeout')
  })
})

describe('latency, so a load run measures something (M2)', () => {
  const elapsed = async (work: () => Promise<unknown>): Promise<number> => {
    const startedAt = Bun.nanoseconds()
    await work()
    return (Bun.nanoseconds() - startedAt) / 1_000_000
  }

  test('is ZERO by default — no existing test slows down', async () => {
    // The load-bearing default. A fake that were slow unless told otherwise would add
    // seconds to every test in this repo, and the knob would be something a test had to
    // remember to turn off rather than something a load run turns on.
    expect(await elapsed(() => createFakeProvider().evaluate(call))).toBeLessThan(50)
  })

  test('is applied when asked for', async () => {
    const provider = createFakeProvider({ latency: { meanMs: 120 } })
    const took = await elapsed(() => provider.evaluate(call))
    expect(took).toBeGreaterThanOrEqual(100)
    // Generously bounded above: this asserts "the delay happened", not the scheduler's
    // precision on a loaded machine.
    expect(took).toBeLessThan(1_500)
  })

  test('is DETERMINISTIC per call, which is what makes two load runs comparable', async () => {
    // The property that separates a repeatable ramp from two samples of noise: the same
    // artifact draws the same delay from any instance, because it comes from the same
    // digest the verdict does. Measured through two fresh providers at a spread wide
    // enough that an accidental collision is implausible rather than merely unlikely.
    const timeFor = (artifact: string) =>
      elapsed(() =>
        createFakeProvider({ latency: { meanMs: 200, spreadMs: 180 } }).evaluate({
          ...call,
          artifact,
        }),
      )

    const first = await timeFor('deterministic artifact')
    const second = await timeFor('deterministic artifact')
    expect(Math.abs(second - first)).toBeLessThan(60)
  })

  test('spreads across calls — a constant would make every judge identically slow', async () => {
    // Scaled down so the assertion costs milliseconds rather than a minute; the shape is
    // what is under test, and the shape does not depend on the magnitude. Twenty different
    // artifacts must not all land on the same delay.
    const provider = createFakeProvider({ latency: { meanMs: 30, spreadMs: 25 } })
    const times: number[] = []
    for (let i = 0; i < 20; i++) {
      times.push(await elapsed(() => provider.evaluate({ ...call, artifact: `artifact ${i}` })))
    }
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(10)
  })

  test('a latency past the deadline is ended BY the abort, exactly as a slow provider is', async () => {
    // Otherwise the fake would outlive the timeout that exists to bound it, and the
    // gateway's whole per-attempt deadline would be advisory against it.
    const provider = createFakeProvider({ latency: { meanMs: 10_000 } })
    const controller = new AbortController()
    const call$ = provider.evaluate({ ...call, signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expectProviderFailure(call$, 'timeout')
  })

  test('MEASURED_JUDGE_LATENCY is the figure retry.ts measured, not a round guess', () => {
    // 4s sits inside the 1877–5304ms range the M1 pin verification recorded, and the spread
    // covers it rather than pretending every judge is identically slow. If retry.ts's table
    // is ever re-measured, this is the other number that has to move.
    expect(MEASURED_JUDGE_LATENCY.meanMs).toBe(4_000)
    expect(MEASURED_JUDGE_LATENCY.spreadMs).toBe(1_500)
  })
})
