import { describe, expect, test } from 'bun:test'
import {
  CAPABILITY_STRUCTURED_OUTPUTS,
  DEFAULT_FAKE_PIN,
  MODEL_ROUTES,
  type ModelPin,
  modelPinSchema,
  modelRefOf,
  parseModelRef,
  REASONING_EFFORTS,
} from './model-pin.ts'

/**
 * This shape goes into a `jdv_` column that ADR-0003 freezes forever, so these tests are
 * less about validation than about the two properties that make the pin worth having: it
 * cannot record a data-collection stance other than `deny`, and it cannot come out of a
 * parse without a concrete reasoning effort on it.
 */

const MINIMAL = {
  capabilities: [CAPABILITY_STRUCTURED_OUTPUTS],
  data_collection: 'deny',
}

describe('the pin', () => {
  test('round-trips through parse and JSON unchanged — it is stored as jsonb', () => {
    const pin: ModelPin = {
      capabilities: [CAPABILITY_STRUCTURED_OUTPUTS],
      data_collection: 'deny',
      quantizations: ['bf16', 'fp8'],
      reasoning: { effort: 'high' },
    }
    expect(modelPinSchema.parse(JSON.parse(JSON.stringify(pin)))).toEqual(pin)
  })

  test('rejects any data-collection stance but `deny` — ADR-0023 has one writable value', () => {
    expect(modelPinSchema.safeParse({ ...MINIMAL, data_collection: 'allow' }).success).toBe(false)
    expect(modelPinSchema.safeParse({ ...MINIMAL, data_collection: 'deny' }).success).toBe(true)
  })

  test('a pin that says nothing about reasoning comes out saying `none`', () => {
    expect(modelPinSchema.parse(MINIMAL).reasoning).toEqual({ effort: 'none' })
    expect(modelPinSchema.parse({ ...MINIMAL, reasoning: {} }).reasoning).toEqual({
      effort: 'none',
    })
  })

  test('a stated effort is kept as the literal it is, never re-defaulted', () => {
    expect(modelPinSchema.parse({ ...MINIMAL, reasoning: { effort: 'medium' } }).reasoning).toEqual(
      { effort: 'medium' },
    )
  })

  test('an effort the models API does not use is rejected rather than stored', () => {
    // `maximum`, not `max` — the near-miss is the interesting case, because a typo that
    // parses would be frozen into a `jdv_` and silently mean something else.
    expect(modelPinSchema.safeParse({ ...MINIMAL, reasoning: { effort: 'maximum' } }).success).toBe(
      false,
    )
    expect(modelPinSchema.safeParse({ ...MINIMAL, reasoning: { effort: 'off' } }).success).toBe(
      false,
    )
  })

  test('accepts every effort the live catalogue actually uses, ordered ascending', () => {
    // Four values did not cover the vocabulary: 20 models DEFAULT to `minimal`, `xhigh` or
    // `max` (measured 2026-08-30), and ADR-0025 requires that default to be written in as a
    // literal — so a missing value made those models unpinnable, not merely awkward.
    expect([...REASONING_EFFORTS]).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    for (const effort of REASONING_EFFORTS) {
      expect(modelPinSchema.parse({ ...MINIMAL, reasoning: { effort } }).reasoning.effort).toBe(
        effort,
      )
    }
  })

  test('`none` and `minimal` stay distinct — one disables, the other is the least possible', () => {
    // A model with mandatory reasoning cannot take `none`; `minimal` is the floor it CAN
    // take, so collapsing them would make that model unpinnable again.
    expect(
      modelPinSchema.parse({ ...MINIMAL, reasoning: { effort: 'minimal' } }).reasoning,
    ).toEqual({ effort: 'minimal' })
    expect(modelPinSchema.parse(MINIMAL).reasoning).toEqual({ effort: 'none' })
  })

  test('`quantizations` is optional, and absent is not the same as empty', () => {
    expect(modelPinSchema.parse(MINIMAL).quantizations).toBeUndefined()
    expect(modelPinSchema.parse({ ...MINIMAL, quantizations: [] }).quantizations).toEqual([])
  })

  test('capabilities is required — a judge with no capability contract is not pinned', () => {
    expect(modelPinSchema.safeParse({ data_collection: 'deny' }).success).toBe(false)
  })

  test('the fake pin is a valid pin, and records `deny` like every other row', () => {
    expect(modelPinSchema.parse(DEFAULT_FAKE_PIN)).toEqual(DEFAULT_FAKE_PIN)
    expect(DEFAULT_FAKE_PIN.data_collection).toBe('deny')
    expect(DEFAULT_FAKE_PIN.reasoning.effort).toBe('none')
  })
})

describe('the `<route>:<id>` grammar', () => {
  test('splits a route-qualified id at the FIRST colon, leaving the id untouched', () => {
    expect(parseModelRef('fake:deterministic')).toEqual({
      route: 'fake',
      nativeId: 'deterministic',
    })
    expect(parseModelRef('openrouter:anthropic/claude-sonnet-5')).toEqual({
      route: 'openrouter',
      nativeId: 'anthropic/claude-sonnet-5',
    })
  })

  test('a bare model name is rejected: it names no access path', () => {
    expect(modelRefOf('claude-sonnet-5')).toBeUndefined()
    expect(modelRefOf('anthropic/claude-sonnet-5')).toBeUndefined()
    expect(() => parseModelRef('claude-sonnet-5')).toThrow(TypeError)
  })

  test('an unknown prefix is rejected — this build has no adapter for it', () => {
    expect(modelRefOf('bedrock:anthropic.claude-opus-5')).toBeUndefined()
    expect(modelRefOf('finetune:acme-tone-v3')).toBeUndefined()
  })

  test('a route with nothing after the colon is rejected, and so is a leading colon', () => {
    expect(modelRefOf('openrouter:')).toBeUndefined()
    expect(modelRefOf(':deterministic')).toBeUndefined()
    expect(modelRefOf('')).toBeUndefined()
  })

  test('every declared route parses, so the list and the parser cannot drift', () => {
    for (const route of MODEL_ROUTES) {
      expect(parseModelRef(`${route}:x`).route).toBe(route)
    }
  })

  test('the thrown message names the model and the routes that do exist', () => {
    expect(() => parseModelRef('claude-sonnet-5')).toThrow(/claude-sonnet-5/)
    expect(() => parseModelRef('claude-sonnet-5')).toThrow(/openrouter/)
  })
})
