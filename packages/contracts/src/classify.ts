import { z } from '@hono/zod-openapi'
import { successEnvelope } from './envelope.ts'
import { idSchema } from './ids.ts'

/**
 * The `/v1/classify/{classifier_id}` contract. The single source of truth for what the
 * endpoint accepts and returns: it drives validation, the TypeScript types, and the
 * published OpenAPI document simultaneously (ADR-0004), so the three cannot drift.
 */

export const CLASSIFY_INPUT_MAX_LENGTH = 8_000

/** The path parameter, whose id also scopes the API key presented with the request. */
export const classifierIdParamSchema = z.object({
  classifier_id: idSchema('cls_', 'The classifier to run. The API key must be scoped to it.'),
})

export const classifyRequestSchema = z
  .object({
    input: z
      .string()
      .min(1, 'input must not be empty')
      .max(
        CLASSIFY_INPUT_MAX_LENGTH,
        `input must be at most ${CLASSIFY_INPUT_MAX_LENGTH} characters`,
      )
      .openapi({
        description: 'The text to classify.',
        example: 'the build is broken',
      }),
    metadata: z
      .record(z.string(), z.string())
      .optional()
      .openapi({
        description:
          'Caller-supplied key/value strings stored with the trace. Never logged — ' +
          'log lines carry metadata about the request, never its content.',
        example: { source: 'jira', ticket: 'ENG-4211' },
      }),
  })
  .openapi('ClassifyRequest')

export const classifyResultSchema = z
  .object({
    label: z.string().openapi({
      description: 'The winning label from the classifier version’s label set.',
      example: 'bug',
    }),
    confidence: z.number().min(0).max(1).openapi({
      description: 'The model’s confidence in the label, from 0 to 1.',
      example: 0.92,
    }),
    trace_id: idSchema(
      'tr_',
      'The stored classification this call produced. Permanent, and the id the trace ' +
        'explorer and annotation surfaces address. Distinct from the envelope’s request_id.',
    ),
  })
  .openapi('ClassifyResult')

/** The full response body: the result wrapped in the success envelope. */
export const classifyResponseSchema =
  successEnvelope(classifyResultSchema).openapi('ClassifyResponse')

/**
 * Mutating endpoints accept an `Idempotency-Key` (CONVENTIONS.md "API rules"). Classify
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

export type ClassifierIdParam = z.infer<typeof classifierIdParamSchema>
export type ClassifyRequest = z.infer<typeof classifyRequestSchema>
export type ClassifyResult = z.infer<typeof classifyResultSchema>
export type ClassifyResponse = z.infer<typeof classifyResponseSchema>
