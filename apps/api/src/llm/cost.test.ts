import { describe, expect, test } from 'bun:test'
import { costOf, MODEL_PRICES } from './cost.ts'
import { FAKE_MODEL } from './fake-provider.ts'

describe('cost accounting', () => {
  test('tokens are reported whether or not the model has a price', () => {
    const cost = costOf('some:unpriced-model', { input: 300, output: 40 })
    expect(cost.inputTokens).toBe(300)
    expect(cost.outputTokens).toBe(40)
    expect(cost.totalTokens).toBe(340)
  })

  test('an unpriced model is reported as unpriced, never guessed at', () => {
    const cost = costOf('some:unpriced-model', { input: 300, output: 40 })
    expect(cost.priced).toBe(false)
    expect(cost.costUsd).toBe(0)
  })

  test('a priced model charges input and output at their own rates', () => {
    MODEL_PRICES['test:priced'] = { inputPerMillion: 3, outputPerMillion: 15 }
    try {
      const cost = costOf('test:priced', { input: 1_000_000, output: 1_000_000 })
      expect(cost.costUsd).toBe(18)
      expect(cost.priced).toBe(true)
    } finally {
      delete MODEL_PRICES['test:priced']
    }
  })

  test('a single call rounds to a real figure rather than float noise', () => {
    MODEL_PRICES['test:priced'] = { inputPerMillion: 3, outputPerMillion: 15 }
    try {
      // 412 input + 57 output — the shape of one judge call, not a million of them.
      expect(costOf('test:priced', { input: 412, output: 57 }).costUsd).toBe(0.002091)
    } finally {
      delete MODEL_PRICES['test:priced']
    }
  })

  test('the fake is free, and priced — M0 bills nothing and says so honestly', () => {
    const cost = costOf(FAKE_MODEL, { input: 1_000, output: 100 })
    expect(cost.priced).toBe(true)
    expect(cost.costUsd).toBe(0)
  })
})
