import type { ErrorReporter } from '../ports/error-reporter.ts'
import { noopErrorReporter } from './noop-error-reporter.ts'

/**
 * The real reporting sink (D6, ADR-0007). Two deliberate constraints:
 *
 * 1. **The SDK is imported dynamically**, inside the factory, so a boot without a
 *    `SENTRY_DSN` never loads it at all. Zero-secret boot is not "loads and stays quiet",
 *    it is "never runs" (ADR-0009).
 * 2. **`initWithoutDefaultIntegrations`**, not `init`. Sentry's defaults install
 *    OpenTelemetry auto-instrumentation, which ADR-0007 bans outright: every span in this
 *    system is written by hand, and a second SDK registering its own tracer provider
 *    would collide with the manual one P6 installs.
 */
export type SentryReporterOptions = {
  dsn: string
  environment: string
  /** The release this process is, so an event points at a version (ADR-0011). */
  release: string
}

export const createSentryErrorReporter = async (
  options: SentryReporterOptions,
): Promise<ErrorReporter> => {
  const Sentry = await import('@sentry/bun')

  Sentry.initWithoutDefaultIntegrations({
    dsn: options.dsn,
    environment: options.environment,
    release: options.release,
    // Reporting only. Tracing is OpenTelemetry's job in this codebase.
    tracesSampleRate: 0,
    // Bodies and headers never leave the process (CONVENTIONS.md "Logging").
    sendDefaultPii: false,
  })

  return {
    report: (error, { requestId, context }) => {
      Sentry.captureException(error, {
        ...(requestId === undefined ? {} : { tags: { request_id: requestId } }),
        ...(context === undefined ? {} : { extra: context }),
      })
    },
    flush: async (timeoutMs = 2_000) => {
      await Sentry.flush(timeoutMs)
    },
  }
}

/**
 * Choose a reporter from configuration. The no-op is the *default*, not a fallback: an
 * unset DSN is a supported state rather than a misconfiguration, so nothing warns.
 */
export const createErrorReporter = async (config: {
  SENTRY_DSN?: string | undefined
  NODE_ENV: string
  APP_VERSION: string
}): Promise<ErrorReporter> =>
  config.SENTRY_DSN === undefined
    ? noopErrorReporter
    : createSentryErrorReporter({
        dsn: config.SENTRY_DSN,
        environment: config.NODE_ENV,
        release: config.APP_VERSION,
      })
