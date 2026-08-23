import { describe, expect, test } from 'bun:test'
import {
  EVALUATE_ARTIFACT_MAX_LENGTH,
  evaluateRequestSchema,
  evaluateResponseSchema,
  evaluationSchema,
  judgeIdParamSchema,
  panelIdParamSchema,
  verdictSchema,
} from './evaluate.ts'
import { newId } from './ids.ts'

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('evaluate request', () => {
  test('accepts an artifact alone, and an artifact with context', () => {
    expect(evaluateRequestSchema.parse({ artifact: 'the build is broken' })).toEqual({
      artifact: 'the build is broken',
    })
    expect(
      evaluateRequestSchema.parse({ artifact: 'x', context: { source: 'github' } }).context,
    ).toEqual({ source: 'github' })
  })

  test('rejects a missing, empty, or oversized artifact with a field-level issue', () => {
    for (const body of [
      {},
      { artifact: '' },
      { artifact: 'x'.repeat(EVALUATE_ARTIFACT_MAX_LENGTH + 1) },
    ]) {
      const result = evaluateRequestSchema.safeParse(body)
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['artifact'])
    }
  })

  test('rejects a non-string artifact and non-string context values', () => {
    expect(evaluateRequestSchema.safeParse({ artifact: 42 }).success).toBe(false)
    expect(evaluateRequestSchema.safeParse({ artifact: 'x', context: { a: 1 } }).success).toBe(
      false,
    )
  })
})

describe('verdict', () => {
  const verdict = {
    judge_id: newId('jud_'),
    key: 'is-missing-repro',
    reasoning: 'Steps are present but no expected-versus-actual behaviour is stated.',
    verdict: true,
  }

  test('parses a full verdict', () => {
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
  })

  test('declares reasoning BEFORE verdict — key order drives generation order', () => {
    // Reversing these two silently turns deliberation into post-hoc rationalisation
    // under structured output, while still producing a valid-looking response.
    const keys = Object.keys(verdictSchema.shape)
    expect(keys.indexOf('reasoning')).toBeLessThan(keys.indexOf('verdict'))
  })

  test('the verdict is binary, not a scale', () => {
    expect(verdictSchema.safeParse({ ...verdict, verdict: 0.7 }).success).toBe(false)
    expect(verdictSchema.safeParse({ ...verdict, verdict: 'maybe' }).success).toBe(false)
  })

  test('requires reasoning — a verdict with no why is not reviewable', () => {
    const { reasoning: _dropped, ...withoutReasoning } = verdict
    expect(verdictSchema.safeParse(withoutReasoning).success).toBe(false)
  })

  test('judge_id must be a jud_ id, not a panel or judge-version id', () => {
    expect(verdictSchema.safeParse({ ...verdict, judge_id: newId('pnl_') }).success).toBe(false)
    expect(verdictSchema.safeParse({ ...verdict, judge_id: newId('jdv_') }).success).toBe(false)
  })
})

describe('evaluation response', () => {
  const evaluation = {
    verdicts: [
      { judge_id: newId('jud_'), key: 'is-bug', reasoning: 'Describes a defect.', verdict: true },
      {
        judge_id: newId('jud_'),
        key: 'is-p0',
        reasoning: 'Not customer-blocking.',
        verdict: false,
      },
    ],
    trace_id: newId('tr_'),
  }

  test('parses many verdicts in one evaluation — a panel is N judges, not one', () => {
    expect(evaluationSchema.parse(evaluation).verdicts).toHaveLength(2)
  })

  test('parses the enveloped response', () => {
    expect(evaluateResponseSchema.parse({ data: evaluation, request_id: REQUEST_ID })).toEqual({
      data: evaluation,
      request_id: REQUEST_ID,
    })
  })

  test('trace_id lives in data, request_id in the envelope (ADR-0010)', () => {
    expect(Object.keys(evaluateResponseSchema.shape)).toEqual(['data', 'request_id'])
    expect(Object.keys(evaluationSchema.shape)).toContain('trace_id')
  })

  test('an empty panel is representable — nothing forces a minimum judge count', () => {
    expect(evaluationSchema.safeParse({ verdicts: [], trace_id: newId('tr_') }).success).toBe(true)
  })
})

describe('path parameters', () => {
  test('panel_id accepts a pnl_ id and rejects anything else', () => {
    const panel_id = newId('pnl_')
    expect(panelIdParamSchema.parse({ panel_id }).panel_id).toBe(panel_id)
    expect(panelIdParamSchema.safeParse({ panel_id: newId('pnv_') }).success).toBe(false)
    expect(panelIdParamSchema.safeParse({ panel_id: 'pnl_nope' }).success).toBe(false)
  })

  test('judge_id accepts a jud_ id, so a single judge can be called directly', () => {
    const judge_id = newId('jud_')
    expect(judgeIdParamSchema.parse({ judge_id }).judge_id).toBe(judge_id)
    expect(judgeIdParamSchema.safeParse({ judge_id: newId('pnl_') }).success).toBe(false)
  })
})
