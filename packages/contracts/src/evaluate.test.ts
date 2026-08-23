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
    status: 'evaluated' as const,
    reasoning: 'Steps are present but no expected-versus-actual behaviour is stated.',
    verdict: true,
    passed: false,
    weight: 0.5,
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

  test('verdict and passed are independent — judges do not all point the same way', () => {
    // is-missing-repro: answering YES means the artifact FAILED that check.
    expect(verdictSchema.parse(verdict)).toMatchObject({ verdict: true, passed: false })
    // on-brand: answering YES means it PASSED. Same booleans, opposite meaning.
    expect(
      verdictSchema.parse({ ...verdict, key: 'on-brand', verdict: true, passed: true }),
    ).toMatchObject({ verdict: true, passed: true })
  })

  test('a skipped or failed judge answers nothing at all — and is not a pass', () => {
    for (const status of ['skipped', 'failed'] as const) {
      const absent = verdictSchema.parse({
        ...verdict,
        status,
        reasoning: null,
        verdict: null,
        passed: null,
        weight: null,
      })
      expect(absent.status, status).toBe(status)
      expect(absent.passed, status).toBeNull()
      expect(absent.verdict, status).toBeNull()
    }
  })

  test('status disambiguates the two reasons passed can be null', () => {
    // Both have passed: null, and they mean completely different things. Without
    // `status` a caller cannot tell "this judge is a label" from "this judge never ran".
    const informational = verdictSchema.parse({ ...verdict, passed: null, weight: null })
    const skipped = verdictSchema.parse({
      ...verdict,
      status: 'skipped',
      reasoning: null,
      verdict: null,
      passed: null,
      weight: null,
    })
    expect(informational.passed).toBe(skipped.passed)
    expect(informational.status).not.toBe(skipped.status)
    expect(informational.verdict).not.toBeNull()
    expect(skipped.verdict).toBeNull()
  })

  test('an unknown status is rejected — the set is closed', () => {
    expect(verdictSchema.safeParse({ ...verdict, status: 'pending' }).success).toBe(false)
  })

  test('an informational judge scores nothing — a label is not a grade', () => {
    // is-bug: answering YES is neither good nor bad. It is a classification, and
    // folding it into a pass/fail score would be meaningless.
    const informational = verdictSchema.parse({
      ...verdict,
      key: 'is-bug',
      verdict: true,
      passed: null,
      weight: null,
    })
    expect(informational.passed).toBeNull()
    expect(informational.weight).toBeNull()
  })

  test('weight is a normalised share, so a caller can recompute the score', () => {
    expect(verdictSchema.safeParse({ ...verdict, weight: 1.4 }).success).toBe(false)
    expect(verdictSchema.safeParse({ ...verdict, weight: -0.1 }).success).toBe(false)
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
  /** Six equally weighted judges, three passing: the worked example from the decision. */
  const sixJudges = (passing: number) =>
    Array.from({ length: 6 }, (_unused, index) => ({
      judge_id: newId('jud_'),
      key: `judge-${index}`,
      reasoning: 'Because.',
      status: 'evaluated' as const,
      verdict: index < passing,
      passed: index < passing,
      weight: 1 / 6,
    }))

  const evaluation = {
    passed: false,
    score: 0.5,
    complete: true,
    threshold: 0.7,
    verdicts: sixJudges(3),
    trace_id: newId('tr_'),
  }

  test('carries the decision, the score, and the bar it was judged against', () => {
    const parsed = evaluationSchema.parse(evaluation)
    expect(parsed.passed).toBe(false)
    expect(parsed.score).toBe(0.5)
    expect(parsed.threshold).toBe(0.7)
  })

  test('the score is recomputable from the verdicts alone — 3 of 6 equal weights is 0.5', () => {
    // The whole point of publishing `weight`: a caller can audit the arithmetic rather
    // than trusting it, which is what a deterministic gate needs.
    const parsed = evaluationSchema.parse(evaluation)
    const recomputed = parsed.verdicts
      .filter((verdict) => verdict.passed === true)
      .reduce((total, verdict) => total + (verdict.weight ?? 0), 0)
    expect(recomputed).toBeCloseTo(parsed.score, 10)
    expect(parsed.passed).toBe(parsed.score >= parsed.threshold)
  })

  test('a panel that clears its bar passes', () => {
    const parsed = evaluationSchema.parse({
      ...evaluation,
      passed: true,
      score: 5 / 6,
      verdicts: sixJudges(5),
    })
    expect(parsed.passed).toBe(true)
    expect(parsed.score >= parsed.threshold).toBe(true)
  })

  test('score and threshold are bounded to 0..1', () => {
    for (const field of ['score', 'threshold'] as const) {
      expect(evaluationSchema.safeParse({ ...evaluation, [field]: 1.5 }).success).toBe(false)
      expect(evaluationSchema.safeParse({ ...evaluation, [field]: -0.1 }).success).toBe(false)
    }
  })

  test('the summary is required — a caller must never have to derive pass/fail itself', () => {
    for (const field of ['passed', 'score', 'threshold', 'complete'] as const) {
      const { [field]: _dropped, ...without } = evaluation
      expect(evaluationSchema.safeParse(without).success, field).toBe(false)
    }
  })

  test('a mixed panel scores only its scoring judges — triage labels do not dilute a gate', () => {
    // A triage panel: three labels that carry no valence, plus one real gate. If the
    // labels were folded into the score, a correctly-labelled bug would drag the gate
    // down for no reason.
    const mixed = {
      passed: true,
      score: 1,
      complete: true,
      threshold: 1,
      verdicts: [
        ...['is-bug', 'is-feature', 'is-question'].map((key) => ({
          judge_id: newId('jud_'),
          key,
          status: 'evaluated' as const,
          reasoning: 'Classification only.',
          verdict: key === 'is-bug',
          passed: null,
          weight: null,
        })),
        {
          judge_id: newId('jud_'),
          key: 'needs-human',
          status: 'evaluated' as const,
          reasoning: 'Clear enough for the bot to route.',
          verdict: false,
          passed: true,
          weight: 1,
        },
      ],
      trace_id: newId('tr_'),
    }
    const parsed = evaluationSchema.parse(mixed)
    const scoring = parsed.verdicts.filter((verdict) => verdict.weight !== null)
    expect(scoring).toHaveLength(1)
    expect(parsed.verdicts).toHaveLength(4)
    // Weights across the SCORING judges sum to 1; the informational three contribute
    // nothing to either side of the fraction.
    expect(scoring.reduce((total, verdict) => total + (verdict.weight ?? 0), 0)).toBe(1)
    expect(parsed.score).toBe(1)
  })

  test('a partial panel is returned and MARKED, not silently scored over fewer judges', () => {
    // Eight of eleven succeeded. The score is real but computed over a smaller
    // denominator, so a gate reading `passed` alone would act on incomplete information.
    // We return it and say so rather than pretending, or failing the whole call.
    const verdicts = sixJudges(5)
    const partial = evaluationSchema.parse({
      ...evaluation,
      passed: true,
      score: 1,
      complete: false,
      verdicts: [
        ...verdicts.slice(0, 5),
        {
          ...verdicts[5],
          status: 'failed',
          reasoning: null,
          verdict: null,
          passed: null,
          weight: null,
        },
      ],
    })
    expect(partial.complete).toBe(false)
    expect(partial.verdicts.filter((v) => v.status !== 'evaluated')).toHaveLength(1)
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
    expect(
      evaluationSchema.safeParse({
        passed: true,
        score: 0,
        complete: true,
        threshold: 0,
        verdicts: [],
        trace_id: newId('tr_'),
      }).success,
    ).toBe(true)
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
