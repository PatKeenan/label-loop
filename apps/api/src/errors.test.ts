import { describe, expect, test } from 'bun:test'
import { ERROR_CODES, ERROR_SPEC } from '@labelloop/contracts'
import { AppError, INTERNAL_MESSAGE, isAppError, toAppError } from './errors.ts'

describe('AppError', () => {
  test('derives status and retryability from the contracts spec, never restating them', () => {
    for (const code of ERROR_CODES) {
      const error = new AppError(code, 'message')
      expect(error.status, code).toBe(ERROR_SPEC[code].status)
      expect(error.retryable, code).toBe(ERROR_SPEC[code].retryable)
    }
  })

  test('is a real Error: instanceof, name, message, and stack all behave', () => {
    const error = new AppError('NOT_FOUND', 'Classifier not found.')
    expect(error).toBeInstanceOf(Error)
    expect(isAppError(error)).toBe(true)
    expect(error.name).toBe('AppError')
    expect(error.message).toBe('Classifier not found.')
    expect(error.stack).toBeDefined()
  })

  test('preserves the underlying cause for the error tracker', () => {
    const cause = new Error('connection refused')
    expect(new AppError('INTERNAL', 'x', { cause }).cause).toBe(cause)
    expect(new AppError('INTERNAL', 'x').cause).toBeUndefined()
  })

  describe('Retry-After is the spec’s decision, not the call site’s', () => {
    test('is kept for codes whose spec promises one', () => {
      expect(new AppError('RATE_LIMITED', 'x', { retryAfterSeconds: 30 }).retryAfterSeconds).toBe(
        30,
      )
      expect(new AppError('CIRCUIT_OPEN', 'x', { retryAfterSeconds: 5 }).retryAfterSeconds).toBe(5)
    })

    test('defaults to one second when the spec promises one and nobody said how long', () => {
      expect(new AppError('PROVIDER_UNAVAILABLE', 'x').retryAfterSeconds).toBe(1)
    })

    test('is DROPPED for codes whose spec does not promise one, even if passed', () => {
      // PROVIDER_TIMEOUT is retryable but carries no honest delay — we do not know when
      // the upstream provider recovers, so we do not pretend to.
      expect(
        new AppError('PROVIDER_TIMEOUT', 'x', { retryAfterSeconds: 9 }).retryAfterSeconds,
      ).toBeUndefined()
      expect(
        new AppError('VALIDATION_ERROR', 'x', { retryAfterSeconds: 9 }).retryAfterSeconds,
      ).toBeUndefined()
    })
  })

  test('carries field issues for VALIDATION_ERROR', () => {
    const issues = [{ path: 'input', message: 'Required' }]
    expect(new AppError('VALIDATION_ERROR', 'x', { issues }).issues).toEqual(issues)
  })
})

describe('toAppError', () => {
  test('passes an AppError through untouched and marks it expected', () => {
    const original = new AppError('FORBIDDEN', 'Not your org.')
    const { appError, unexpected } = toAppError(original)
    expect(appError).toBe(original)
    expect(unexpected).toBe(false)
  })

  test.each([
    ['a raw Error', new Error('psql: FATAL: password authentication failed for user "app"')],
    ['a thrown string', 'connection string postgres://app:hunter2@db/labelloop'],
    ['a thrown object', { secret: 'llk_live_abc123' }],
    ['null', null],
    ['undefined', undefined],
  ])('wraps %s as INTERNAL and never lets its content become the message', (_label, thrown) => {
    const { appError, unexpected } = toAppError(thrown)
    expect(unexpected).toBe(true)
    expect(appError.code).toBe('INTERNAL')
    expect(appError.status).toBe(500)
    expect(appError.message).toBe(INTERNAL_MESSAGE)
    // The original is kept, but only for the tracker — it is not the wire message.
    expect(appError.cause).toBe(thrown)
  })

  test('INTERNAL is not advertised as retryable', () => {
    // We do not know what broke, so we do not invite the caller to hammer it.
    expect(toAppError(new Error('?')).appError.retryable).toBe(false)
  })
})
