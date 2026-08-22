import { describe, expect, test } from 'bun:test'
import { ERROR_CODES, ERROR_SPEC, type ErrorCode, errorSpec, isErrorCode } from './errors.ts'

/**
 * Transcribed by hand from CONVENTIONS.md "Error handling" so that the table and the
 * code cannot drift silently: this fixture is the doc, the map is the implementation.
 */
const CONVENTIONS_TABLE: ReadonlyArray<readonly [ErrorCode, number, boolean]> = [
  ['VALIDATION_ERROR', 422, false],
  ['UNAUTHORIZED', 401, false],
  ['FORBIDDEN', 403, false],
  ['NOT_FOUND', 404, false],
  ['IDEMPOTENCY_CONFLICT', 409, false],
  ['RATE_LIMITED', 429, true],
  ['QUOTA_EXCEEDED', 429, false],
  ['PROVIDER_TIMEOUT', 504, true],
  ['PROVIDER_UNAVAILABLE', 503, true],
  ['CIRCUIT_OPEN', 503, true],
  ['INTERNAL', 500, false],
]

describe('error taxonomy', () => {
  test('is exhaustive: every code has a spec and every spec has a code', () => {
    expect(Object.keys(ERROR_SPEC).sort()).toEqual([...ERROR_CODES].sort())
  })

  test('matches the CONVENTIONS table exactly — no extras, no omissions', () => {
    expect(CONVENTIONS_TABLE.map(([code]) => code)).toEqual([...ERROR_CODES])
    for (const [code, status, retryable] of CONVENTIONS_TABLE) {
      expect(errorSpec(code).status, code).toBe(status as never)
      expect(errorSpec(code).retryable, code).toBe(retryable)
    }
  })

  test('the codes that promise a Retry-After are exactly the 429/503 retryables', () => {
    const withRetryAfter = ERROR_CODES.filter((code) => ERROR_SPEC[code].retryAfter)
    expect(withRetryAfter).toEqual(['RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'CIRCUIT_OPEN'])
    for (const code of withRetryAfter) expect(ERROR_SPEC[code].retryable).toBe(true)
  })

  test('a non-retryable code never asks the client to retry after a delay', () => {
    for (const code of ERROR_CODES) {
      if (!ERROR_SPEC[code].retryable) expect(ERROR_SPEC[code].retryAfter).toBe(false)
    }
  })

  test('the two 429s differ only in retryability (quota is terminal, rate limit is not)', () => {
    expect(errorSpec('RATE_LIMITED').status).toBe(errorSpec('QUOTA_EXCEEDED').status)
    expect(errorSpec('RATE_LIMITED').retryable).toBe(true)
    expect(errorSpec('QUOTA_EXCEEDED').retryable).toBe(false)
  })

  test('isErrorCode narrows only known codes', () => {
    expect(isErrorCode('INTERNAL')).toBe(true)
    expect(isErrorCode('TEAPOT')).toBe(false)
    expect(isErrorCode(500)).toBe(false)
    expect(isErrorCode(undefined)).toBe(false)
  })
})
