import { describe, expect, test } from 'bun:test'
import { ERROR_CODES, ERROR_SPEC, type ErrorCode } from '@labelloop/contracts'
import { errorTreatment } from './error-map.ts'

/**
 * The structural guarantee is a TYPE one — `bun run typecheck` fails when a code has no
 * case — so these tests cover what the compiler cannot: that the copy exists and is
 * non-empty, and that the affordance the UI offers agrees with what the API actually
 * promised about retrying. A treatment that offers a retry button for a code the taxonomy
 * marks non-retryable compiles perfectly and is a lie to the user.
 */

describe('every code in the taxonomy has a UI treatment', () => {
  test.each([...ERROR_CODES])('%s', (code) => {
    const treatment = errorTreatment(code)
    expect(treatment.title.length).toBeGreaterThan(0)
    expect(treatment.detail.length).toBeGreaterThan(0)
  })
})

describe('the affordance agrees with the taxonomy', () => {
  /** `retry` and `wait` are the two that put a "try again" in front of the user. */
  const offersRetry = (code: ErrorCode) => ['retry', 'wait'].includes(errorTreatment(code).recovery)

  test.each([...ERROR_CODES])('%s offers a retry only if the code is retryable', (code) => {
    expect(offersRetry(code)).toBe(ERROR_SPEC[code].retryable)
  })

  test.each([...ERROR_CODES])('%s waits only when the response carries Retry-After', (code) => {
    // `wait` means "hold the button for Retry-After seconds", which is only meaningful for
    // the codes whose spec promises that header.
    if (errorTreatment(code).recovery !== 'wait') return
    expect(ERROR_SPEC[code].retryAfter).toBe(true)
  })

  test('the two 429s are treated as opposites, because they are', () => {
    // Same HTTP status, opposite meaning. A UI that branches on the status rather than the
    // taxonomy code tells a customer who is out of quota to wait a moment.
    expect(ERROR_SPEC.RATE_LIMITED.status).toBe(ERROR_SPEC.QUOTA_EXCEEDED.status)
    expect(errorTreatment('RATE_LIMITED').fatal).toBe(false)
    expect(errorTreatment('QUOTA_EXCEEDED').fatal).toBe(true)
  })
})
