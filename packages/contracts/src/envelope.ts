import { z } from '@hono/zod-openapi'
import { ERROR_CODES } from './errors.ts'

/**
 * The response envelope (CONVENTIONS.md "API rules"): success `{ data, request_id }`,
 * failure `{ error: { code, message }, request_id }`.
 *
 * `request_id` — never `trace_id` — is what rides in the envelope (ADR-0010). It names
 * one HTTP execution, exists from the moment the request arrives, and is therefore the
 * only candidate that survives a request that fails before anything is persisted.
 */

/** A W3C trace id: 32 lowercase hex characters, all-zero being the invalid id. */
export const REQUEST_ID_PATTERN = /^(?!0{32}$)[0-9a-f]{32}$/

export const requestIdSchema = z
  .string()
  .regex(REQUEST_ID_PATTERN, 'must be a 32-character lowercase hex W3C trace id')
  .openapi({
    description:
      'The W3C trace id of this HTTP execution. Present on every response, success or ' +
      'failure. Quote it to support; it resolves to this request’s logs and spans.',
    example: '4bf92f3577b34da6a3ce929d0e0e4736',
  })

export const errorCodeSchema = z.enum(ERROR_CODES).openapi({
  description: 'A member of the closed error taxonomy.',
  example: 'VALIDATION_ERROR',
})

/**
 * One field-level complaint from contract validation. Present only on
 * `VALIDATION_ERROR`, which is why it is optional rather than a second envelope shape.
 */
export const errorIssueSchema = z
  .object({
    path: z.string().openapi({ example: 'input', description: 'Dotted path to the field.' }),
    message: z.string().openapi({ example: 'Required' }),
  })
  .openapi('ErrorIssue')

export const errorBodySchema = z
  .object({
    code: errorCodeSchema,
    message: z.string().openapi({
      description: 'A safe, caller-facing message. Never carries internal detail.',
      example: 'Request body failed validation.',
    }),
    issues: z.array(errorIssueSchema).optional().openapi({
      description: 'Field-level validation failures. Only present on VALIDATION_ERROR.',
    }),
  })
  .openapi('ErrorBody')

export const errorEnvelopeSchema = z
  .object({ error: errorBodySchema, request_id: requestIdSchema })
  .openapi('ErrorEnvelope')

/** Wrap a payload schema in the success envelope. */
export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, request_id: requestIdSchema })

export type ErrorIssue = z.infer<typeof errorIssueSchema>
export type ErrorBody = z.infer<typeof errorBodySchema>
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>
export type SuccessEnvelope<T> = { data: T; request_id: string }
