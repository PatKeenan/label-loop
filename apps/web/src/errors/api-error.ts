import { type ErrorCode, errorEnvelopeSchema } from '@labelloop/contracts'
import { type ErrorTreatment, errorTreatment } from './error-map.ts'

/**
 * Turning a failed response into something renderable.
 *
 * Every failure from this API is the same envelope — `{ error: { code, message }, request_id }`
 * — so there is exactly one parser, and it validates against the SAME schema the API
 * generates its OpenAPI document from. A body that does not match is not trusted into the
 * error map: a proxy's HTML error page or a network failure has no taxonomy code, and
 * inventing one for it would put the wrong affordance in front of the user.
 */

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly treatment: ErrorTreatment
  /** Quote it to support. Absent only when the failure never reached the API. */
  readonly requestId: string | undefined

  constructor(code: ErrorCode, message: string, requestId?: string) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.treatment = errorTreatment(code)
    this.requestId = requestId
  }
}

/**
 * The two things this needs from a response, and no more.
 *
 * Structural rather than `Response` because Hono's RPC client returns its own
 * `ClientResponse` — the same thing with the body type attached — and demanding the DOM
 * class would force a cast at every call site to satisfy a difference that does not matter
 * here.
 */
type FailedResponse = {
  status: number
  json: () => Promise<unknown>
}

/**
 * Read a non-2xx response as an `ApiError`.
 *
 * Anything unrecognisable becomes `INTERNAL`, which is the honest answer: we know it
 * failed, we cannot say why in the taxonomy's terms, and `INTERNAL`'s treatment is exactly
 * "something went wrong on our side, quote the request id".
 */
export const apiErrorFrom = async (response: FailedResponse): Promise<ApiError> => {
  const body: unknown = await response.json().catch(() => undefined)
  const parsed = errorEnvelopeSchema.safeParse(body)
  if (!parsed.success) {
    return new ApiError('INTERNAL', `The API returned ${response.status} with no error body.`)
  }
  return new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.request_id)
}
