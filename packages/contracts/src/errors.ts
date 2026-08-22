/**
 * The closed error taxonomy (CONVENTIONS.md "Error handling").
 *
 * A new code is a change to this file and nothing else: adding one to `ERROR_CODES`
 * without adding its row to `ERROR_SPEC` fails typecheck here, and fails again in
 * `apps/web`'s exhaustive error map until someone decides what the user sees.
 */

export const ERROR_CODES = [
  'VALIDATION_ERROR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
  'CIRCUIT_OPEN',
  'INTERNAL',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Every HTTP status the taxonomy is allowed to produce. */
export type ErrorHttpStatus = 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503 | 504

export type ErrorSpec = {
  readonly status: ErrorHttpStatus
  /** Whether a client may retry the identical request and expect a different outcome. */
  readonly retryable: boolean
  /**
   * Whether responses carrying this code must set a `Retry-After` header. Only
   * meaningful when `retryable` is true; the central handler reads it.
   */
  readonly retryAfter: boolean
}

/**
 * Status + retry semantics per code. Typed as a total `Record` over `ErrorCode`, so a
 * code without a row is a compile error rather than a runtime `undefined`.
 */
export const ERROR_SPEC: Record<ErrorCode, ErrorSpec> = {
  VALIDATION_ERROR: { status: 422, retryable: false, retryAfter: false },
  UNAUTHORIZED: { status: 401, retryable: false, retryAfter: false },
  FORBIDDEN: { status: 403, retryable: false, retryAfter: false },
  NOT_FOUND: { status: 404, retryable: false, retryAfter: false },
  IDEMPOTENCY_CONFLICT: { status: 409, retryable: false, retryAfter: false },
  RATE_LIMITED: { status: 429, retryable: true, retryAfter: true },
  QUOTA_EXCEEDED: { status: 429, retryable: false, retryAfter: false },
  PROVIDER_TIMEOUT: { status: 504, retryable: true, retryAfter: false },
  PROVIDER_UNAVAILABLE: { status: 503, retryable: true, retryAfter: true },
  CIRCUIT_OPEN: { status: 503, retryable: true, retryAfter: true },
  INTERNAL: { status: 500, retryable: false, retryAfter: false },
}

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value)

export const errorSpec = (code: ErrorCode): ErrorSpec => ERROR_SPEC[code]
