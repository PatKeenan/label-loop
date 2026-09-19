import { describe, expect, test } from 'bun:test'
import {
  aggregationSchema,
  EVALUATE_MAX_BYTES,
  evaluateRequestSchema,
  evaluateResponseSchema,
  evaluateRolesBytes,
  evaluationSchema,
  judgeIdParamSchema,
  judgeOutputSchema,
  panelIdParamSchema,
  RATIONALE_MAX_LENGTH,
  verdictSchema,
} from './evaluate.ts'
import { newId } from './ids.ts'

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('evaluate request — four roles, in native shapes (ADR-0073)', () => {
  const MESSAGES_WITH_TOOL_CALLS = [
    { role: 'user', content: 'Was I charged twice?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'charges', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '[{"amount":49},{"amount":49}]' },
  ]

  test.each([
    ['a string', 'the build is broken'],
    ['an object (a proposal)', { action: 'refund', amount: 588 }],
    ['an array', [1, 'two', { three: 3 }]],
    ['messages with tool calls', MESSAGES_WITH_TOOL_CALLS],
    ['a number', 42],
    ['null', null],
  ])('accepts %s as input and as output', (_, value) => {
    expect(evaluateRequestSchema.parse({ input: value, output: value })).toEqual({
      input: value,
      output: value,
    })
  })

  test('reference takes any JSON per key; metadata is strings only', () => {
    const parsed = evaluateRequestSchema.parse({
      input: 'x',
      output: 'y',
      reference: { account: { plan: 'pro' }, charges: [49, 49] },
      metadata: { conversation_id: 'c_1' },
    })
    expect(parsed.reference).toEqual({ account: { plan: 'pro' }, charges: [49, 49] })
    expect(parsed.metadata).toEqual({ conversation_id: 'c_1' })
    expect(
      evaluateRequestSchema.safeParse({ input: 'x', output: 'y', metadata: { n: 1 } }).success,
    ).toBe(false)
  })

  test.each(['input', 'output'] as const)('%s is required, with a field-level issue', (role) => {
    const body: Record<string, unknown> = { input: 'x', output: 'y' }
    delete body[role]
    const result = evaluateRequestSchema.safeParse(body)
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual([role])
  })

  test('the retired artifact and context are refused, naming their replacements', () => {
    for (const retired of [{ artifact: 'x' }, { context: { a: 'b' } }]) {
      const result = evaluateRequestSchema.safeParse({ input: 'x', output: 'y', ...retired })
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.message).toContain('replaced by `input`, `output`')
    }
    // And the old request on its own: no silent strip into a bare "output is required".
    const old = evaluateRequestSchema.safeParse({ artifact: 'x', context: { a: 'b' } })
    expect(old.error?.issues.map((issue) => issue.code)).toContain('unrecognized_keys')
  })

  test('the cap is 64 KiB across the roles serialised — exactly at it passes, one over fails', () => {
    // A string serialises with its two quotes, so this output is exactly the remaining bytes.
    const input = 'i'
    const room = EVALUATE_MAX_BYTES - evaluateRolesBytes({ input })
    const atCap = { input, output: 'o'.repeat(room - 2) }
    expect(evaluateRolesBytes(atCap)).toBe(EVALUATE_MAX_BYTES)
    expect(evaluateRequestSchema.safeParse(atCap).success).toBe(true)

    const over = evaluateRequestSchema.safeParse({ input, output: 'o'.repeat(room - 1) })
    expect(over.success).toBe(false)
    expect(over.error?.issues[0]?.path).toEqual(['output'])
  })

  test('the cap counts BYTES, not characters, and names the largest role', () => {
    // 'é' is two bytes in UTF-8: half the cap in characters is already over it in bytes.
    const result = evaluateRequestSchema.safeParse({
      input: 'é'.repeat(EVALUATE_MAX_BYTES / 2),
      output: 'short',
    })
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.path).toEqual(['input'])
  })
})

describe('judge output — what the model is asked to produce', () => {
  const output = {
    rationale: 'Steps are present but no expected-versus-actual behaviour is stated.',
    reasons: ['missing-expected-behaviour'],
    verdict: true,
    confidence: 0.82,
  }

  test('parses a complete judge output', () => {
    expect(judgeOutputSchema.parse(output)).toEqual(output)
  })

  test('declares rationale BEFORE verdict — key order drives generation order', () => {
    // This is the one schema whose property order is load-bearing, because it IS the
    // structured-output schema. Reversing these turns deliberation into post-hoc
    // rationalisation while still producing a valid-looking response.
    const keys = Object.keys(judgeOutputSchema.shape)
    expect(keys.indexOf('rationale')).toBeLessThan(keys.indexOf('verdict'))
    expect(keys.indexOf('reasons')).toBeLessThan(keys.indexOf('verdict'))
    // Confidence comes last: assess how sure you are after deciding, not before.
    expect(keys.indexOf('verdict')).toBeLessThan(keys.indexOf('confidence'))
  })

  test('the rationale is capped — every character lands in the caller’s context window', () => {
    expect(
      judgeOutputSchema.safeParse({ ...output, rationale: 'x'.repeat(RATIONALE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false)
  })

  test('the verdict is binary and the confidence is bounded', () => {
    expect(judgeOutputSchema.safeParse({ ...output, verdict: 0.7 }).success).toBe(false)
    expect(judgeOutputSchema.safeParse({ ...output, confidence: 1.2 }).success).toBe(false)
    expect(judgeOutputSchema.safeParse({ ...output, confidence: -0.1 }).success).toBe(false)
  })

  test('reasons are codes an agent can branch on, and may be empty', () => {
    expect(judgeOutputSchema.parse({ ...output, reasons: [] }).reasons).toEqual([])
    expect(judgeOutputSchema.safeParse({ ...output, reasons: 'nope' }).success).toBe(false)
  })
})

describe('verdict', () => {
  const verdict = {
    judge_id: newId('jud_'),
    status: 'evaluated' as const,
    error_code: null,
    rationale: 'Steps are present but no expected-versus-actual behaviour is stated.',
    reasons: ['missing-expected-behaviour'],
    verdict: true,
    confidence: 0.82,
    passed: false,
    weight: 0.5,
    served_by: 'frontier:sonnet',
    latency_ms: 412,
    attempts: 1,
  }

  test('parses a full verdict', () => {
    expect(verdictSchema.parse(verdict)).toEqual(verdict)
  })

  test('verdict and passed are independent — judges do not all point the same way', () => {
    // is-missing-repro: answering YES means the artifact FAILED that check.
    expect(verdictSchema.parse(verdict)).toMatchObject({ verdict: true, passed: false })
    // on-brand: answering YES means it PASSED. Same booleans, opposite meaning.
    expect(verdictSchema.parse({ ...verdict, verdict: true, passed: true })).toMatchObject({
      verdict: true,
      passed: true,
    })
  })

  test('a judge that did not answer is never a pass, whatever the reason', () => {
    for (const status of ['skipped_sampling', 'failed', 'error'] as const) {
      const absent = verdictSchema.parse({
        ...verdict,
        status,
        rationale: null,
        reasons: [],
        verdict: null,
        confidence: null,
        passed: null,
        weight: null,
        served_by: null,
      })
      expect(absent.passed, status).toBeNull()
      expect(absent.verdict, status).toBeNull()
      expect(absent.confidence, status).toBeNull()
    }
  })

  test('failed and error are different things, and error names its cause', () => {
    // failed = the call completed and the answer was unusable; a rubric problem.
    // error  = the call never completed; infrastructure, often worth retrying.
    expect(verdictSchema.parse({ ...verdict, status: 'failed' }).error_code).toBeNull()
    expect(
      verdictSchema.parse({ ...verdict, status: 'error', error_code: 'PROVIDER_TIMEOUT' })
        .error_code,
    ).toBe('PROVIDER_TIMEOUT')
    expect(verdictSchema.safeParse({ ...verdict, error_code: 'KAPUT' }).success).toBe(false)
  })

  test('an unknown status is rejected — the set is closed', () => {
    expect(verdictSchema.safeParse({ ...verdict, status: 'pending' }).success).toBe(false)
  })

  test('served_by makes graduation visible in every payload', () => {
    expect(verdictSchema.parse({ ...verdict, served_by: 'finetune:acme-tone-v3' }).served_by).toBe(
      'finetune:acme-tone-v3',
    )
  })

  test('attempts starts at 1 — a judge that ran once ran once', () => {
    expect(verdictSchema.safeParse({ ...verdict, attempts: 0 }).success).toBe(false)
    expect(verdictSchema.safeParse({ ...verdict, latency_ms: -1 }).success).toBe(false)
  })
})

describe('aggregation', () => {
  test('records the policy and pins the panel version that produced the decision', () => {
    const panel_version = newId('pnv_')
    const parsed = aggregationSchema.parse({ policy: 'weighted_threshold', panel_version })
    expect(parsed.policy).toBe('weighted_threshold')
    expect(parsed.panel_version).toBe(panel_version)
  })

  test('the policy set is closed, and weighted_threshold is deliberately the only one', () => {
    // "Unanimous" is threshold 1. "Quorum(n)" is equal weights with the threshold set
    // accordingly. "Veto" is a required judge. One mechanism, presets in the console.
    expect(
      aggregationSchema.safeParse({ policy: 'unanimous', panel_version: newId('pnv_') }).success,
    ).toBe(false)
  })

  test('the pinned version must be a panel version, not a panel', () => {
    expect(
      aggregationSchema.safeParse({ policy: 'weighted_threshold', panel_version: newId('pnl_') })
        .success,
    ).toBe(false)
  })
})

describe('evaluation response', () => {
  /** Six equally weighted judges, three passing: the worked example from the decision. */
  const sixJudges = (passing: number) =>
    Object.fromEntries(
      Array.from({ length: 6 }, (_unused, index) => [
        `judge-${index}`,
        {
          judge_id: newId('jud_'),
          status: 'evaluated' as const,
          error_code: null,
          rationale: 'Because.',
          reasons: [],
          verdict: index < passing,
          confidence: 0.9,
          passed: index < passing,
          weight: 1 / 6,
          served_by: 'frontier:sonnet',
          latency_ms: 300 + index,
          attempts: 1,
        },
      ]),
    )

  const evaluation = {
    state: 'judged' as const,
    passed: false,
    score: 0.5,
    complete: true,
    threshold: 0.7,
    aggregation: { policy: 'weighted_threshold' as const, panel_version: newId('pnv_') },
    judges: sixJudges(3),
    trace_id: newId('tr_'),
  }

  /**
   * Parse, and assert the JUDGED shape while doing it.
   *
   * `passed` and `score` are nullable on the contract since ADR-0060, because a COLLECTING
   * panel has no verdict — so every test below that reads them as numbers has to say it is
   * looking at a judged evaluation. Stating it here makes that an assertion rather than a
   * cast, and it is the invariant worth holding: **a judged panel always has both.**
   */
  const parseJudged = (input: unknown) => {
    const parsed = evaluationSchema.parse(input)
    if (parsed.state !== 'judged' || parsed.passed === null || parsed.score === null) {
      throw new Error('expected a judged evaluation with a verdict and a score')
    }
    return { ...parsed, passed: parsed.passed, score: parsed.score }
  }

  test('carries the decision, the score, and the bar it was judged against', () => {
    const parsed = evaluationSchema.parse(evaluation)
    expect(parsed.passed).toBe(false)
    expect(parsed.score).toBe(0.5)
    expect(parsed.threshold).toBe(0.7)
  })

  test('judges are keyed by slug, so an agent can ask about one by name', () => {
    const parsed = evaluationSchema.parse(evaluation)
    expect(parsed.judges['judge-0']?.verdict).toBe(true)
    expect(parsed.judges['judge-5']?.verdict).toBe(false)
    expect(Object.keys(parsed.judges)).toHaveLength(6)
  })

  test('the score is recomputable from the judges alone — 3 of 6 equal weights is 0.5', () => {
    // The whole point of publishing `weight`: a caller can audit the arithmetic rather
    // than trusting it, which is what a deterministic gate needs.
    const parsed = parseJudged(evaluation)
    const recomputed = Object.values(parsed.judges)
      .filter((judge) => judge.passed === true)
      .reduce((total, judge) => total + (judge.weight ?? 0), 0)
    expect(recomputed).toBeCloseTo(parsed.score, 10)
    expect(parsed.passed).toBe(parsed.score >= parsed.threshold)
  })

  test('a panel that clears its bar passes', () => {
    const parsed = parseJudged({
      ...evaluation,
      passed: true,
      score: 5 / 6,
      judges: sixJudges(5),
    })
    expect(parsed.passed).toBe(true)
    expect(parsed.score >= parsed.threshold).toBe(true)
  })

  test('a panel of judges pointing in opposite directions still sums to one score', () => {
    // Four judges that all score (ADR-0034), two of each polarity. The `passes` judges
    // pass on `true` and the `fails` judges pass on `false`, which is exactly why `passed`
    // is not a copy of `verdict` — and why the weights, not the verdicts, are what sum.
    const base = {
      judge_id: newId('jud_'),
      status: 'evaluated' as const,
      error_code: null,
      rationale: 'A reason.',
      reasons: [],
      confidence: 0.9,
      served_by: 'frontier:sonnet',
      latency_ms: 200,
      attempts: 1,
    }
    const parsed = evaluationSchema.parse({
      ...evaluation,
      passed: true,
      score: 1,
      judges: {
        'on-brand': { ...base, verdict: true, passed: true, weight: 0.25 },
        'answers-the-question': { ...base, verdict: true, passed: true, weight: 0.25 },
        'mis-routed': { ...base, verdict: false, passed: true, weight: 0.25 },
        'is-missing-repro': { ...base, verdict: false, passed: true, weight: 0.25 },
      },
    })
    const scoring = Object.values(parsed.judges).filter((judge) => judge.weight !== null)
    expect(Object.keys(parsed.judges)).toHaveLength(4)
    // Every judge scores: there is no subset to filter out.
    expect(scoring).toHaveLength(4)
    expect(scoring.reduce((total, judge) => total + (judge.weight ?? 0), 0)).toBe(1)
    expect(parsed.score).toBe(1)
  })

  test('a partial panel is returned and MARKED, not silently scored over fewer judges', () => {
    // The score is real but computed over a smaller denominator, so a gate reading
    // `passed` alone would act on incomplete information. We return it and say so.
    const judges = sixJudges(5)
    const partial = evaluationSchema.parse({
      ...evaluation,
      passed: true,
      score: 1,
      complete: false,
      judges: {
        ...judges,
        'judge-5': {
          ...judges['judge-5'],
          status: 'error',
          error_code: 'PROVIDER_TIMEOUT',
          rationale: null,
          reasons: [],
          verdict: null,
          confidence: null,
          passed: null,
          weight: null,
          served_by: null,
        },
      },
    })
    expect(partial.complete).toBe(false)
    expect(
      Object.values(partial.judges).filter((judge) => judge.status !== 'evaluated'),
    ).toHaveLength(1)
  })

  test('score and threshold are bounded to 0..1', () => {
    for (const field of ['score', 'threshold'] as const) {
      expect(evaluationSchema.safeParse({ ...evaluation, [field]: 1.5 }).success).toBe(false)
      expect(evaluationSchema.safeParse({ ...evaluation, [field]: -0.1 }).success).toBe(false)
    }
  })

  test('the summary is required — a caller must never have to derive pass/fail itself', () => {
    for (const field of ['passed', 'score', 'threshold', 'complete', 'aggregation'] as const) {
      const { [field]: _dropped, ...without } = evaluation
      expect(evaluationSchema.safeParse(without).success, field).toBe(false)
    }
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
        ...evaluation,
        passed: true,
        score: 0,
        threshold: 0,
        judges: {},
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
