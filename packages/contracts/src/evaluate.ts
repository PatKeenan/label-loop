import { z } from '@hono/zod-openapi'
import { errorCodeSchema, successEnvelope } from './envelope.ts'
import { idSchema } from './ids.ts'

/**
 * The evaluation contract (ADR-0019). A caller sends an artifact to a panel and receives
 * one verdict per judge, each with its reasoning.
 *
 * Two endpoints share these shapes:
 *   POST /v1/panels/{panel_id}/evaluate   — run every judge on the panel
 *   POST /v1/judges/{judge_id}/evaluate   — run one judge directly
 *
 * We never generate the artifact; the caller's agent does that and hands us the result
 * (ADR-0019). We *are* the inference path for the judge calls, which is what keeps
 * ADR-0001's server-side trace capture true.
 *
 * A judge's polarity is part of its configuration, not of the artifact: each judge
 * declares whether answering `true` is a pass, a fail, or neither. Without that, the
 * panel score is uncomputable, because summing raw booleans across judges that point in
 * opposite directions is meaningless.
 */

export const EVALUATE_ARTIFACT_MAX_LENGTH = 32_000

/**
 * What we ASK a judge for: one line for a human, not an essay. Judges are called from
 * inside someone else's agent loop, and every character comes back into that agent's
 * context window — so verbosity here is a cost the caller pays on every request.
 *
 * It is stated in the prompt, because that is the only place a model can act on it.
 */
export const RATIONALE_TARGET_LENGTH = 280

/**
 * What we REFUSE above — a genuine essay, not a near miss.
 *
 * **These are two numbers because they answer two questions, and conflating them cost a
 * working judge.** Until 2026-08-31 the target was also the bound: 280 was sent as
 * `maxLength` under `strict: true`, never mentioned in the prompt, and enforced by
 * rejecting the parse. Structured output does not enforce string length — providers
 * constrain SHAPE, not size — so the cap was advisory on the wire and absolute on the way
 * back in. Measured against the live API on 2026-08-30, `anthropic/claude-sonnet-5`
 * produced rationale lengths of 274, 292, 296, 331 and 384 on an identical probe and so
 * failed validation on 4 of 5 attempts, while `openai/gpt-5.6-sol` (153-239) and
 * `google/gemini-3.7-flash` (111-153) passed 5 of 5. A model was never told the limit and
 * was then refused for exceeding it.
 *
 * The failure modes are asymmetric, which is what fixes the number. Too high costs a few
 * dozen tokens of verbosity on one response. Too low DISCARDS a correct verdict — the
 * reasoning, the taxonomy codes and the answer are all fine and all thrown away over
 * prose length — and bills for it again on the retry. So the target is what we ask for and
 * this is the outer bound, set far enough above that tripping it means the model wrote an
 * essay rather than a long sentence.
 */
export const RATIONALE_MAX_LENGTH = 1_000

export const panelIdParamSchema = z.object({
  panel_id: idSchema('pnl_', 'The panel to run. The API key must be scoped to it.'),
})

export const judgeIdParamSchema = z.object({
  judge_id: idSchema('jud_', 'A single judge to run directly, without its panel.'),
})

export const evaluateRequestSchema = z
  .object({
    artifact: z
      .string()
      .min(1, 'artifact must not be empty')
      .max(
        EVALUATE_ARTIFACT_MAX_LENGTH,
        `artifact must be at most ${EVALUATE_ARTIFACT_MAX_LENGTH} characters`,
      )
      .openapi({
        description:
          'The thing to be judged — a generated asset, a bug report, a model output. ' +
          'Produced by your system, not ours.',
        example: 'Login button does nothing on Safari 17. Repro: click it. Nothing happens.',
      }),
    context: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        description:
          'Anything else the judges need in order to decide — brand guidelines, the ' +
          'originating prompt, the ticket’s reporter. Assembling this is the caller’s ' +
          'job; we do not gather context or call tools.',
        example: { source: 'github', repo: 'acme/web' },
      }),
  })
  .openapi('EvaluateRequest')

/**
 * **What the model itself is asked to produce.** This is the structured-output schema for
 * a single judge call — not the whole `Verdict`, which wraps it in metadata we compute.
 *
 * **Field order here is load-bearing and this is the only place it is.** These models are
 * autoregressive: a verdict emitted before its reasoning makes that reasoning a post-hoc
 * rationalisation, and the verdict itself gets no deliberation. Under structured output
 * the schema's property order determines generation order, so `rationale` → `reasons` →
 * `verdict` → `confidence` is deliberate: think, categorise, decide, then assess how sure
 * you are. Reordering these silently produces a worse judge that still looks correct.
 */
export const judgeOutputSchema = z
  .object({
    rationale: z.string().max(RATIONALE_MAX_LENGTH).openapi({
      description: 'Why, in one line for a human. Generated FIRST — see the note on order.',
      example: 'Steps are present but no expected-versus-actual behaviour is stated.',
    }),
    reasons: z.array(z.string()).openapi({
      description:
        'Taxonomy codes, drawn from the panel’s versioned failure taxonomy. This is the ' +
        'field an agent branches on: prose cannot be acted upon, but a code can be ' +
        'mapped to a remediation. The axial-coded taxonomy IS the remediation vocabulary, ' +
        'which is what makes a propose→judge→revise loop directed rather than random.',
      example: ['missing-expected-behaviour'],
    }),
    verdict: z.boolean().openapi({
      description:
        'The judge’s raw answer to its own question. Binary by design: scale ratings ' +
        'have poor inter-rater reliability for both humans and models, so magnitude ' +
        'comes from the proportion of traces failing a judge, not from a dial. This is ' +
        'the field an annotator agrees with or corrects.',
      example: true,
    }),
    confidence: z
      .number()
      .min(0)
      .max(1)
      .openapi({
        description:
          'How sure the judge is, 0 to 1. Not a softened verdict — the verdict stays ' +
          'binary. This drives low-confidence sampling, which is one of the better ways to ' +
          'spend a subject-matter expert’s attention (PRODUCT 5.5).',
        example: 0.82,
      }),
  })
  .openapi('JudgeOutput')

export const VERDICT_STATUSES = ['evaluated', 'skipped_sampling', 'failed', 'error'] as const

export const verdictStatusSchema = z.enum(VERDICT_STATUSES).openapi({
  description:
    'What happened to this judge on this call.\n' +
    '- `evaluated` — it ran and answered.\n' +
    '- `skipped_sampling` — sampling excluded it, so it has no opinion.\n' +
    '- `failed` — the call COMPLETED but the answer was unusable: unparseable output, a ' +
    'refusal, a response that did not match the schema. Usually a rubric problem, and ' +
    'retrying the identical request tends not to help.\n' +
    '- `error` — the call DID NOT COMPLETE: provider timeout, circuit open, rate limit, ' +
    'context length exceeded. Usually infrastructure, and often worth retrying. ' +
    '`error_code` names which.\n\n' +
    'The split matters because the two demand opposite responses. None of the three ' +
    'non-`evaluated` statuses is a pass, and a caller must never treat one as one.',
  example: 'evaluated',
})

/**
 * One judge's finding: what the model produced, plus what we know about the call.
 *
 * The model-generated fields are nullable because a judge that was skipped, failed or
 * errored produced nothing at all — and returning a default in their place would be a
 * lie the caller acts on.
 */
export const verdictSchema = z
  .object({
    judge_id: idSchema('jud_'),
    status: verdictStatusSchema,
    error_code: errorCodeSchema.nullable().openapi({
      description:
        'Why the call did not complete, drawn from the same closed taxonomy as every ' +
        'other error in the API. Non-null only when `status` is `error`, so a caller can ' +
        'branch on PROVIDER_TIMEOUT (retry) versus CIRCUIT_OPEN (do not) without parsing ' +
        'prose.',
      example: 'PROVIDER_TIMEOUT',
    }),
    rationale: z.string().nullable().openapi({
      description: 'From the judge. Null unless `status` is `evaluated`.',
      example: 'Steps are present but no expected-versus-actual behaviour is stated.',
    }),
    reasons: z.array(z.string()).openapi({
      description: 'Taxonomy codes from the judge. Empty unless `status` is `evaluated`.',
      example: ['missing-expected-behaviour'],
    }),
    verdict: z.boolean().nullable().openapi({
      description: 'The judge’s raw answer, or null when it did not answer.',
      example: true,
    }),
    confidence: z.number().min(0).max(1).nullable().openapi({
      description: 'The judge’s certainty, or null when it did not answer.',
      example: 0.82,
    }),
    passed: z
      .boolean()
      .nullable()
      .openapi({
        description:
          'Whether that answer counts as a PASS for this judge. Null in two distinct ' +
          'cases, which `status` disambiguates: the judge is informational and does not ' +
          'score (`status: evaluated`), or it never answered. NOT a duplicate of ' +
          '`verdict`: judges point in different directions. `is-missing-repro: true` is a ' +
          'failure, `on-brand: true` is a success, and `is-bug: true` is neither — it is a ' +
          'label. Each judge declares its own polarity, and this is that polarity applied.',
        example: false,
      }),
    weight: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .openapi({
        description:
          'This judge’s normalised share of the panel score, or null when it did not ' +
          'contribute — informational, skipped, failed or errored. Weights across the ' +
          'judges that DID score sum to 1, so a caller can recompute `score` themselves.',
        example: 0.1667,
      }),
    served_by: z
      .string()
      .nullable()
      .openapi({
        description:
          'Which model actually answered — `frontier:sonnet`, `finetune:acme-tone-v3`. ' +
          'Puts the graduation story in every payload: a caller can watch a judge move ' +
          'from frontier to fine-tune without changing a line of their own code.',
        example: 'frontier:sonnet',
      }),
    latency_ms: z
      .number()
      .int()
      .min(0)
      .openapi({
        description:
          'Wall-clock for this judge. Judges fan out in parallel, so the panel’s total is ' +
          'the slowest one — this is what tells you which seat shapes your p99.',
        example: 412,
      }),
    attempts: z
      .number()
      .int()
      .min(1)
      .openapi({
        description:
          'How many times this judge was called before the status was reached. Surfaces ' +
          'retry flakiness that a success would otherwise hide.',
        example: 1,
      }),
  })
  .openapi('Verdict')

/**
 * How a panel turns judge verdicts into one decision.
 *
 * Only one policy exists, deliberately: `weighted_threshold` expresses the named policies
 * people ask for without four code paths. "Unanimous" is a threshold of 1. "Quorum(n)" is
 * equal weights with the threshold set accordingly. "Veto" is a `required` judge, which
 * fails the panel outright whatever the score. The console offers these as presets over
 * the one mechanism; short-circuit evaluation is deliberately absent until latency data
 * justifies the sampling it would cost.
 */
export const AGGREGATION_POLICIES = ['weighted_threshold'] as const

export const aggregationSchema = z
  .object({
    policy: z.enum(AGGREGATION_POLICIES).openapi({
      description: 'How verdicts were combined.',
      example: 'weighted_threshold',
    }),
    panel_version: idSchema(
      'pnv_',
      'The immutable panel version that produced this decision — weights, threshold and ' +
        'judge set. Pinned into every trace, so a score timeline can never silently span ' +
        'a configuration change (ADR-0003).',
    ),
  })
  .openapi('Aggregation')

/**
 * The whole result: a decision at the top, the reasoning underneath.
 *
 * Both halves earn their place. A deterministic step in a workflow reads `passed` and
 * moves on. An agent deciding what to do next reads the judges, because "which judge
 * failed and why" is what it can act on — regenerate for this reason, escalate for that
 * one. Returning only the summary would make the second case impossible; returning only
 * the detail would make every caller reimplement the same policy.
 */
export const evaluationSchema = z
  .object({
    passed: z.boolean().openapi({
      description:
        'Whether the panel’s score met its configured threshold, and no required judge ' +
        'failed. The panel decides this only because the customer configured the weights ' +
        'and the bar — we never decide a caller’s risk tolerance on their behalf.',
      example: false,
    }),
    score: z
      .number()
      .min(0)
      .max(1)
      .openapi({
        description:
          'The weighted share of scoring judges that passed, from 0 to 1. Six equally ' +
          'weighted judges with three passing scores 0.5. Informational judges are absent ' +
          'from both the numerator and the denominator — a label is not a grade — as are ' +
          'skipped, failed and errored ones. Check `complete` before trusting this as a ' +
          'whole-panel number.',
        example: 0.5,
      }),
    complete: z.boolean().openapi({
      description:
        'Whether every scoring judge on the panel actually ran. When false, some judge ' +
        'was skipped, failed or errored and `score` was computed over a SMALLER ' +
        'denominator — so the number is real but partial, and a gate reading `passed` ' +
        'alone would be acting on incomplete information. We return the partial result ' +
        'and say so, rather than pretending or failing the whole call because one judge ' +
        'did.',
      example: true,
    }),
    threshold: z
      .number()
      .min(0)
      .max(1)
      .openapi({
        description:
          'The bar this panel version was configured with, echoed so the decision is ' +
          'auditable from the response alone rather than requiring a config lookup.',
        example: 0.7,
      }),
    aggregation: aggregationSchema,
    judges: z.record(z.string(), verdictSchema).openapi({
      description:
        'Every judge that was considered, keyed by its stable slug — `judges["is-p0"]`. ' +
        'Keyed rather than a list because the common case is an agent asking about one ' +
        'specific judge, and the slug is the name a developer writes in their code.',
    }),
    trace_id: idSchema(
      'tr_',
      'The stored evaluation this call produced. Permanent, and the id the trace ' +
        'explorer and annotation surfaces address. Distinct from the envelope’s request_id.',
    ),
  })
  .openapi('Evaluation')

export const evaluateResponseSchema = successEnvelope(evaluationSchema).openapi('EvaluateResponse')

/**
 * Mutating endpoints accept an `Idempotency-Key` (CONVENTIONS.md "API rules"). Evaluation
 * is naturally idempotent per request, so the header is optional here.
 */
export const idempotencyKeyHeaderSchema = z.object({
  'idempotency-key': z
    .string()
    .min(1)
    .max(255)
    .optional()
    .openapi({ description: 'Optional client-supplied idempotency key.' }),
})

export type PanelIdParam = z.infer<typeof panelIdParamSchema>
export type JudgeIdParam = z.infer<typeof judgeIdParamSchema>
export type EvaluateRequest = z.infer<typeof evaluateRequestSchema>
export type JudgeOutput = z.infer<typeof judgeOutputSchema>
export type VerdictStatus = (typeof VERDICT_STATUSES)[number]
export type Verdict = z.infer<typeof verdictSchema>
export type AggregationPolicy = (typeof AGGREGATION_POLICIES)[number]
export type Aggregation = z.infer<typeof aggregationSchema>
export type Evaluation = z.infer<typeof evaluationSchema>
export type EvaluateResponse = z.infer<typeof evaluateResponseSchema>
