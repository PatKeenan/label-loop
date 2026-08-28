import type { ErrorCode } from '@labelloop/contracts'

/**
 * The frontend error map (CONVENTIONS.md "Error handling"), and the reason it is a
 * `switch` with a `never` at the bottom rather than a lookup table.
 *
 * The rule is that front and back cannot silently drift: adding a code to
 * `packages/contracts` must FAIL THIS APP'S TYPECHECK until someone decides what the user
 * sees. A `Record<ErrorCode, …>` would enforce that too, but only for a missing key — this
 * shape also refuses to compile if a code is REMOVED and a stale case is left behind, and
 * it puts the decision at a place in the file where the copy is right next to the code it
 * belongs to. The `assertExhaustive` call is not defensive programming; it is the
 * enforcement.
 *
 * What each treatment means:
 * - `fatal` — the request cannot succeed as written by this user, now. The UI stops and
 *   explains. Non-fatal means the same request may well work later.
 * - `recovery` — the affordance to offer. `retry` is a button, `wait` is a button the UI
 *   should hold for `Retry-After` seconds, `fix-input` is the form's problem, `sign-in` is
 *   a redirect, `contact-support` is the request id and nothing else to try.
 *
 * The copy is deliberately plain and unstyled, matching the rest of the console at M0.
 * Making it good is M4's job; making it EXIST for every code is this phase's.
 */

export type Recovery = 'retry' | 'wait' | 'fix-input' | 'sign-in' | 'contact-support'

export type ErrorTreatment = {
  /** A short line for a heading. */
  title: string
  /** One sentence saying what to do about it. */
  detail: string
  fatal: boolean
  recovery: Recovery
}

/**
 * Reached only if a code exists at runtime that did not exist at compile time — a console
 * running against a newer API. It throws rather than guessing, because a wrong treatment
 * (offering a retry on a quota failure, say) is worse than a visible bug.
 */
const assertExhaustive = (code: never): never => {
  throw new Error(`No UI treatment for error code ${String(code)}`)
}

export const errorTreatment = (code: ErrorCode): ErrorTreatment => {
  switch (code) {
    case 'VALIDATION_ERROR':
      return {
        title: 'That request was not valid',
        detail: 'Check the highlighted fields and try again.',
        fatal: false,
        recovery: 'fix-input',
      }
    case 'UNAUTHORIZED':
      return {
        title: 'You are signed out',
        detail: 'Sign in again to continue.',
        fatal: false,
        recovery: 'sign-in',
      }
    case 'FORBIDDEN':
      return {
        title: 'You do not have access to this',
        detail: 'Ask an owner of this organisation to grant you access.',
        fatal: true,
        recovery: 'contact-support',
      }
    case 'NOT_FOUND':
      return {
        title: 'Not found',
        detail: 'This may have been deleted, or the link may be wrong.',
        fatal: true,
        recovery: 'contact-support',
      }
    case 'IDEMPOTENCY_CONFLICT':
      return {
        title: 'This was already submitted',
        detail:
          'The same idempotency key was used with a different request. Reload to see the result.',
        fatal: true,
        recovery: 'contact-support',
      }
    case 'RATE_LIMITED':
      return {
        title: 'Too many requests',
        detail: 'Wait a moment and try again.',
        fatal: false,
        // The only two codes that carry Retry-After, so the only two whose affordance is a
        // timer rather than a button (ERROR_SPEC.retryAfter — asserted in the test).
        recovery: 'wait',
      }
    case 'QUOTA_EXCEEDED':
      return {
        title: 'Quota exceeded',
        detail: 'This organisation has used its allowance. Retrying will not help.',
        // Shares 429 with RATE_LIMITED and means the opposite: waiting changes nothing.
        // Reading the status code instead of the taxonomy code is how a UI gets this wrong.
        fatal: true,
        recovery: 'contact-support',
      }
    case 'PROVIDER_TIMEOUT':
      return {
        title: 'The model took too long',
        detail: 'Nothing was charged and nothing was saved. Try again.',
        fatal: false,
        recovery: 'retry',
      }
    case 'PROVIDER_UNAVAILABLE':
      return {
        title: 'The model is unavailable',
        detail: 'The provider is not answering right now. Try again shortly.',
        fatal: false,
        recovery: 'wait',
      }
    case 'CIRCUIT_OPEN':
      return {
        title: 'Paused after repeated failures',
        detail: 'Calls to this model are paused so it can recover. Try again shortly.',
        fatal: false,
        recovery: 'wait',
      }
    case 'INTERNAL':
      return {
        title: 'Something went wrong on our side',
        detail: 'Quote the request id if you contact support.',
        fatal: true,
        recovery: 'contact-support',
      }
    default:
      return assertExhaustive(code)
  }
}
