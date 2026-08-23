import { describe, expect, test } from 'bun:test'
import { noopErrorReporter } from './noop-error-reporter.ts'
import { createErrorReporter } from './sentry-error-reporter.ts'

describe('reporter selection', () => {
  test('an unset SENTRY_DSN yields the no-op — the Sentry SDK is never even imported', async () => {
    // Identity, not shape: returning the no-op object proves the dynamic `import()` in
    // the other branch was never reached, which is what zero-secret boot means (ADR-0009).
    const reporter = await createErrorReporter({ NODE_ENV: 'development', APP_VERSION: '1.0.0' })
    expect(reporter).toBe(noopErrorReporter)
  })

  test('the no-op swallows everything without throwing', async () => {
    expect(() =>
      noopErrorReporter.report(new Error('x'), { requestId: 'a'.repeat(32) }),
    ).not.toThrow()
    await expect(noopErrorReporter.flush(10)).resolves.toBeUndefined()
  })

  test('an explicitly undefined DSN is the same as an absent one', async () => {
    const reporter = await createErrorReporter({
      SENTRY_DSN: undefined,
      NODE_ENV: 'production',
      APP_VERSION: '1.0.0',
    })
    expect(reporter).toBe(noopErrorReporter)
  })
})
