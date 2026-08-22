import { ERROR_SPEC, type ErrorCode, type ErrorIssue } from '@labelloop/contracts'

/**
 * The error *machinery*. The taxonomy itself lives in `@labelloop/contracts`, which is
 * why this file has no list of codes in it: `AppError` reads status and retry semantics
 * out of `ERROR_SPEC`, so the two can never disagree.
 *
 * The rule this file exists to enforce (CONVENTIONS.md "Error handling"):
 * **route handlers throw, they never build error responses.** One `app.onError` and one
 * `notFound` own all serialization, in `app.ts`.
 */

export type AppErrorOptions = {
  /** The underlying failure. Reported to the tracker; never serialized to the caller. */
  cause?: unknown
  /** Field-level detail. Only meaningful for `VALIDATION_ERROR`. */
  issues?: readonly ErrorIssue[]
  /** Seconds until a retry is worth attempting. Only for codes whose spec sets `retryAfter`. */
  retryAfterSeconds?: number
  /** Structured, non-sensitive context for the error tracker. Never bodies. */
  context?: Record<string, unknown>
}

/**
 * The only error type whose message is allowed to cross the wire. Anything else that
 * reaches the central handler becomes an `INTERNAL` with a generic message, because an
 * unplanned error's message may contain anything at all — a connection string, a row of
 * customer data, an internal hostname.
 */
export class AppError extends Error {
  override readonly name = 'AppError'
  readonly code: ErrorCode
  readonly status: number
  readonly retryable: boolean
  readonly retryAfterSeconds: number | undefined
  readonly issues: readonly ErrorIssue[] | undefined
  readonly context: Record<string, unknown> | undefined

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    const spec = ERROR_SPEC[code]
    this.code = code
    this.status = spec.status
    this.retryable = spec.retryable
    this.issues = options.issues
    this.context = options.context
    // A Retry-After on a code whose spec does not promise one would be noise, so the
    // spec decides whether the value is kept, not the call site.
    this.retryAfterSeconds = spec.retryAfter ? (options.retryAfterSeconds ?? 1) : undefined
  }
}

export const isAppError = (error: unknown): error is AppError => error instanceof AppError

/**
 * The generic message an unexpected failure gets. Deliberately says nothing: the detail
 * goes to the error tracker, and the caller gets the `request_id` to quote at support.
 */
export const INTERNAL_MESSAGE =
  'An unexpected error occurred. Quote the request_id if you contact support.'

/**
 * Normalize anything throwable into an `AppError`. The `unexpected` flag is what the
 * central handler uses to decide whether to report: an `AppError` is a *planned* outcome
 * of a request, and paging on planned outcomes is how alert fatigue starts.
 */
export const toAppError = (error: unknown): { appError: AppError; unexpected: boolean } => {
  if (isAppError(error)) return { appError: error, unexpected: false }
  return {
    appError: new AppError('INTERNAL', INTERNAL_MESSAGE, { cause: error }),
    unexpected: true,
  }
}
