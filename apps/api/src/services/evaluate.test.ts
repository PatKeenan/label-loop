import { describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, evaluationSchema, newId } from '@labelloop/contracts'
import type { JudgeCallOutcome } from '../llm/index.ts'
import type { PanelJudge } from '../repositories/panels.ts'
import { aggregate } from './evaluate.ts'

/**
 * The scoring rules, tested without a database or a provider, because they are the part
 * with the product in them: polarity, weight normalisation over the judges that actually
 * ran, the required-judge veto, and what `complete` means.
 */

const PANEL_VERSION = newId('pnv_')
const TRACE = newId('tr_')

const judge = (overrides: Partial<PanelJudge> & { slug: string }): PanelJudge => ({
  judgeId: newId('jud_'),
  judgeVersionId: newId('jdv_'),
  type: 'llm',
  polarity: 'fails',
  weight: 1,
  required: false,
  question: 'A binary question.',
  model: 'fake:deterministic',
  modelPin: DEFAULT_FAKE_PIN,
  ...overrides,
})

const answered = (verdict: boolean): JudgeCallOutcome => ({
  status: 'evaluated',
  output: { rationale: 'because', reasons: verdict ? ['a-code'] : [], verdict, confidence: 0.8 },
  cost: { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0, priced: true },
  servedBy: 'fake:deterministic',
  raw: { fake: true },
  attempts: 1,
  latencyMs: 12,
})

const errored = (code: 'PROVIDER_TIMEOUT' | 'CIRCUIT_OPEN'): JudgeCallOutcome => ({
  status: 'error',
  code,
  message: 'The judge could not be reached.',
  attempts: 3,
  latencyMs: 40,
})

const run = (pairs: Array<[PanelJudge, JudgeCallOutcome]>, threshold: number) =>
  aggregate(
    pairs.map(([judge, outcome]) => ({ judge, outcome })),
    { threshold, panelVersionId: PANEL_VERSION },
    TRACE,
  )

describe('polarity', () => {
  test('a `fails` judge passes when it answers false', () => {
    const evaluation = run([[judge({ slug: 'is-missing-repro' }), answered(false)]], 0.5)
    expect(evaluation.judges['is-missing-repro']?.verdict).toBe(false)
    expect(evaluation.judges['is-missing-repro']?.passed).toBe(true)
  })

  test('a `passes` judge passes when it answers true — the opposite direction', () => {
    const evaluation = run([[judge({ slug: 'on-brand', polarity: 'passes' }), answered(true)]], 0.5)
    expect(evaluation.judges['on-brand']?.verdict).toBe(true)
    expect(evaluation.judges['on-brand']?.passed).toBe(true)
  })

  test('an informational judge scores nothing: no `passed`, no weight, no denominator', () => {
    const evaluation = run(
      [
        [judge({ slug: 'is-bug', polarity: 'does_not_score', weight: null }), answered(true)],
        [judge({ slug: 'needs-human' }), answered(false)],
      ],
      0.5,
    )
    expect(evaluation.judges['is-bug']?.verdict).toBe(true)
    expect(evaluation.judges['is-bug']?.passed).toBeNull()
    expect(evaluation.judges['is-bug']?.weight).toBeNull()
    // One scoring judge, and it passed: a label with no valence changed nothing.
    expect(evaluation.score).toBe(1)
  })
})

describe('the score', () => {
  test('is the weighted share of the judges that passed', () => {
    const evaluation = run(
      [
        [judge({ slug: 'a', weight: 1 }), answered(false)],
        [judge({ slug: 'b', weight: 1 }), answered(true)],
        [judge({ slug: 'c', weight: 1 }), answered(false)],
        [judge({ slug: 'd', weight: 1 }), answered(true)],
      ],
      0.5,
    )
    expect(evaluation.score).toBe(0.5)
    expect(evaluation.passed).toBe(true)
  })

  test('honours unequal weights, normalised to sum to 1 across the judges that scored', () => {
    const evaluation = run(
      [
        [judge({ slug: 'heavy', weight: 3 }), answered(false)],
        [judge({ slug: 'light', weight: 1 }), answered(true)],
      ],
      0.5,
    )
    expect(evaluation.judges.heavy?.weight).toBe(0.75)
    expect(evaluation.judges.light?.weight).toBe(0.25)
    expect(evaluation.score).toBe(0.75)
  })

  test('the reported weights sum to 1, so a caller can recompute the score', () => {
    const evaluation = run(
      [
        [judge({ slug: 'a', weight: 1 }), answered(false)],
        [judge({ slug: 'b', weight: 1 }), answered(false)],
        [judge({ slug: 'c', weight: 1 }), answered(true)],
      ],
      0.5,
    )
    const total = Object.values(evaluation.judges).reduce((sum, v) => sum + (v.weight ?? 0), 0)
    expect(total).toBeCloseTo(1, 10)
  })

  test('the threshold is a bar, not a suggestion: exactly at it passes', () => {
    const pair: Array<[PanelJudge, JudgeCallOutcome]> = [
      [judge({ slug: 'a' }), answered(false)],
      [judge({ slug: 'b' }), answered(true)],
    ]
    expect(run(pair, 0.5).passed).toBe(true)
    expect(run(pair, 0.51).passed).toBe(false)
  })
})

describe('a judge that did not run', () => {
  test('is absent from the denominator — the score is real but partial', () => {
    const evaluation = run(
      [
        [judge({ slug: 'a', weight: 1 }), answered(false)],
        [judge({ slug: 'b', weight: 1 }), answered(false)],
        [judge({ slug: 'c', weight: 1 }), errored('PROVIDER_TIMEOUT')],
      ],
      0.5,
    )
    // Two judges scored, both passed: 1.0 over the smaller set, NOT 0.67 over all three.
    expect(evaluation.score).toBe(1)
    expect(evaluation.judges.c?.weight).toBeNull()
  })

  test('makes the panel incomplete, which is the field a gate has to read', () => {
    const evaluation = run(
      [
        [judge({ slug: 'a' }), answered(false)],
        [judge({ slug: 'b' }), errored('PROVIDER_TIMEOUT')],
      ],
      0.5,
    )
    expect(evaluation.complete).toBe(false)
    expect(evaluation.judges.b?.status).toBe('error')
    expect(evaluation.judges.b?.error_code).toBe('PROVIDER_TIMEOUT')
    expect(evaluation.judges.b?.verdict).toBeNull()
    expect(evaluation.judges.b?.rationale).toBeNull()
  })

  test('an informational judge failing does not make the panel incomplete', () => {
    const evaluation = run(
      [
        [judge({ slug: 'a' }), answered(false)],
        [
          judge({ slug: 'label', polarity: 'does_not_score', weight: null }),
          errored('PROVIDER_TIMEOUT'),
        ],
      ],
      0.5,
    )
    // `complete` is about the SCORE's denominator. A label was lost, and the score is
    // still the whole of what the score was ever going to be.
    expect(evaluation.complete).toBe(true)
  })
})

describe('a required judge is a veto', () => {
  test('failing it fails the panel whatever the score says', () => {
    const evaluation = run(
      [
        [judge({ slug: 'gate', required: true, weight: 1 }), answered(true)],
        [judge({ slug: 'a', weight: 99 }), answered(false)],
      ],
      0.5,
    )
    expect(evaluation.score).toBeGreaterThan(0.5)
    expect(evaluation.passed).toBe(false)
  })

  test('so does never reaching it — an unanswered veto is not a satisfied one', () => {
    const evaluation = run(
      [
        [judge({ slug: 'gate', required: true }), errored('CIRCUIT_OPEN')],
        [judge({ slug: 'a', weight: 1 }), answered(false)],
      ],
      0.5,
    )
    expect(evaluation.score).toBe(1)
    expect(evaluation.passed).toBe(false)
  })
})

describe('the shape of the answer', () => {
  test('satisfies the published contract, including the pinned panel version', () => {
    const evaluation = run(
      [
        [judge({ slug: 'a' }), answered(false)],
        [judge({ slug: 'b', polarity: 'does_not_score', weight: null }), answered(true)],
      ],
      0.7,
    )
    expect(evaluationSchema.safeParse(evaluation).success).toBe(true)
    expect(evaluation.aggregation).toEqual({
      policy: 'weighted_threshold',
      panel_version: PANEL_VERSION,
    })
    expect(evaluation.threshold).toBe(0.7)
    expect(evaluation.trace_id).toBe(TRACE)
  })

  test('a panel of nothing but labels makes no claim to fail', () => {
    const evaluation = run(
      [[judge({ slug: 'a', polarity: 'does_not_score', weight: null }), answered(true)]],
      0.9,
    )
    expect(evaluation.passed).toBe(true)
    expect(evaluation.complete).toBe(true)
    expect(evaluation.score).toBe(0)
  })
})
