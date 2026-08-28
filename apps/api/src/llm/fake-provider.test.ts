import { describe, expect, test } from 'bun:test'
import { createFakeProvider, FAKE_MODEL, FAKE_SENTINELS } from './fake-provider.ts'
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
