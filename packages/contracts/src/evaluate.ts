import { z } from '@hono/zod-openapi'
import { successEnvelope } from './envelope.ts'
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
 * NOTE FOR M0-P4: two questions in ADR-0019 are still open and deliberately absent here —
 * whether a panel also returns an overall verdict derived from a caller-configured policy,
 * and how a judge skipped by sampling is represented (it must be distinguishable from a
 * pass). Both add fields; neither changes what is below.
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
        'Whether this judge’s condition holds. Binary by design: scale ratings have ' +
        'poor inter-rater reliability for both humans and models, so magnitude comes ' +
        'from the proportion of traces failing a judge, not from a dial.',
      example: true,
    }),
  })
  .openapi('Verdict')

export const evaluationSchema = z
  .object({
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
