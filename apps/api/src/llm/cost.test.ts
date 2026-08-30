import { describe, expect, test } from 'bun:test'
import { costOf, MODEL_PRICES } from './cost.ts'
import { FAKE_MODEL } from './fake-provider.ts'

describe('the provider’s own figure', () => {
  test('is preferred over the table, and counts as priced', () => {
    // ADR-0027: it already accounts for cached input, tiered and per-endpoint rates, and
    // reasoning billed at rates the catalogue does not publish. Recomputing it would be
    // inventing a second, quieter answer to a question the provider already answered.
    const cost = costOf(
      'openrouter:anthropic/claude-sonnet-5',
      { input: 2717, output: 181 },
      0.007244,
    )
    expect(cost.costUsd).toBe(0.007244)
    expect(cost.priced).toBe(true)
  })

  test('wins even where the table would also have answered', () => {
    MODEL_PRICES['test:priced'] = { inputPerMillion: 3, outputPerMillion: 15 }
    try {
      expect(costOf('test:priced', { input: 412, output: 57 }, 0.009).costUsd).toBe(0.009)
    } finally {
      delete MODEL_PRICES['test:priced']
    }
  })

  test('a REPORTED zero is priced — it is a claim, not a gap', () => {
    // The distinction the whole `priced` flag exists for: somebody who knows told us it
    // was free. M2 may sum this; it must never sum an unpriced zero.
    const cost = costOf('openrouter:something/free', { input: 10, output: 10 }, 0)
    expect(cost.costUsd).toBe(0)
    expect(cost.priced).toBe(true)
  })

  test('a missing or nonsensical figure falls back rather than trusting it', () => {
    expect(costOf('some:unpriced-model', { input: 10, output: 10 }).priced).toBe(false)
    expect(costOf('some:unpriced-model', { input: 10, output: 10 }, Number.NaN).priced).toBe(false)
    expect(
      costOf('some:unpriced-model', { input: 10, output: 10 }, Number.POSITIVE_INFINITY).priced,
    ).toBe(false)
  })

  test('reasoning tokens are carried when reported, and ABSENT when not', () => {
    expect(costOf('m:x', { input: 1, output: 1, reasoning: 269 }, 0.001).reasoningTokens).toBe(269)
    // Absent, not zero: a provider that said nothing has not said "none". Measured
    // 2026-08-30, one model reported 0 at `minimal` and 269 at `high` — both are claims,
    // and neither is the same as silence.
    expect(costOf('m:x', { input: 1, output: 1, reasoning: 0 }, 0.001).reasoningTokens).toBe(0)
    expect(costOf('m:x', { input: 1, output: 1 }, 0.001).reasoningTokens).toBeUndefined()
  })

  test('reasoning tokens are NOT folded into the output count', () => {
    // They are billed separately and cannot be read back, so adding them to `output` would
    // make the visible half of the answer look bigger than it is.
    const cost = costOf('m:x', { input: 100, output: 50, reasoning: 269 }, 0.001)
    expect(cost.outputTokens).toBe(50)
    expect(cost.totalTokens).toBe(150)
  })
})

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
