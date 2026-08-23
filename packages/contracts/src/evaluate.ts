import { z } from '@hono/zod-openapi'
import { successEnvelope } from './envelope.ts'
import { idSchema } from './ids.ts'

/**
 * The evaluation contract (ADR-0019). A caller sends an artifact to a panel and receives
 * one verdict per judge, each with its reasoning.
 *
 * A judge's polarity is part of its configuration, not of the artifact: each judge
 * declares whether answering `true` is a pass, a fail, or neither. Without that, the
 * panel score is uncomputable, because summing raw booleans across judges that point in
 * opposite directions is meaningless.
 *
 * Two endpoints share these shapes:
 *   POST /v1/panels/{panel_id}/evaluate   — run every judge on the panel
 *   POST /v1/judges/{judge_id}/evaluate   — run one judge directly
 *
 * We never generate the artifact; the caller's agent does that and hands us the result
 * (ADR-0019). We *are* the inference path for the judge calls, which is what keeps
 * ADR-0001's server-side trace capture true.
 *
 * NOTE FOR M0-P4: one question in ADR-0019 is still open and deliberately absent here —
 * how a judge skipped by sampling is represented, which must be distinguishable from a
 * pass and must be excluded from the score's denominator. It adds fields; it does not
 * change what is below.
 */

export const EVALUATE_ARTIFACT_MAX_LENGTH = 32_000

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
 * One judge's finding.
 *
 * **Key order is load-bearing.** `reasoning` is declared before `verdict` because these
 * models are autoregressive: a verdict generated first makes its reasoning a post-hoc
 * rationalisation, and the verdict itself gets no deliberation. Under structured output
 * the schema's property order determines generation order, so reversing these two fields
 * silently produces a worse judge that still looks correct (CONVENTIONS.md, ADR-0019).
 */
export const verdictSchema = z
  .object({
    judge_id: idSchema('jud_'),
    key: z.string().openapi({
      description: 'The judge’s stable slug, for callers keying off it in code.',
      example: 'is-missing-repro',
    }),
    reasoning: z.string().openapi({
      description: 'Why. Generated BEFORE the verdict — see the note on key order.',
      example: 'Steps are present but no expected-versus-actual behaviour is stated.',
    }),
    verdict: z.boolean().openapi({
      description:
        'The judge’s raw answer to its own question. Binary by design: scale ratings ' +
        'have poor inter-rater reliability for both humans and models, so magnitude ' +
        'comes from the proportion of traces failing a judge, not from a dial. This is ' +
        'the field an annotator agrees with or corrects.',
      example: true,
    }),
    passed: z
      .boolean()
      .nullable()
      .openapi({
        description:
          'Whether that answer counts as a PASS for this judge, or `null` if the judge is ' +
          'informational and does not score. NOT a duplicate of `verdict`: judges point in ' +
          'different directions. `is-missing-repro: true` is a failure, `on-brand: true` ' +
          'is a success, and `is-bug: true` is neither — it is a label. Each judge declares ' +
          'its own polarity, and this is that polarity applied, so the score has something ' +
          'consistent to sum.',
        example: false,
      }),
    weight: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .openapi({
        description:
          'This judge’s normalised share of the panel score, or `null` when it is ' +
          'informational. Weights across the SCORING judges of a panel sum to 1, so a ' +
          'caller can recompute `score` themselves and see exactly why it came out where ' +
          'it did.',
        example: 0.1667,
      }),
  })
  .openapi('Verdict')

/**
 * The whole result: a decision at the top, the reasoning underneath.
 *
 * Both halves earn their place. A deterministic step in a workflow reads `passed` and
 * moves on. An agent deciding what to do next reads the verdicts, because "which judge
 * failed and why" is what it can act on — regenerate for this reason, escalate for that
 * one. Returning only the summary would make the second case impossible; returning only
 * the detail would make every caller reimplement the same policy.
 */
export const evaluationSchema = z
  .object({
    passed: z.boolean().openapi({
      description:
        'Whether the panel’s score met its configured threshold. The panel decides this ' +
        'only because the customer configured the weights and the bar — we never decide ' +
        'a caller’s risk tolerance on their behalf.',
      example: false,
    }),
    score: z
      .number()
      .min(0)
      .max(1)
      .openapi({
        description:
          'The weighted share of judges that passed, from 0 to 1. Six equally weighted ' +
          'judges with three passing scores 0.5.',
        example: 0.5,
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
    verdicts: z.array(verdictSchema).openapi({
      description: 'One entry per judge that ran, in panel order.',
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
export type Verdict = z.infer<typeof verdictSchema>
export type Evaluation = z.infer<typeof evaluationSchema>
export type EvaluateResponse = z.infer<typeof evaluateResponseSchema>
