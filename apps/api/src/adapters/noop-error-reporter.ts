import type { ErrorReporter } from '../ports/error-reporter.ts'

/**
 * The default reporter. Boot without a `SENTRY_DSN` is a supported, silent state
 * (ADR-0009) — not a degraded one — so this adapter does nothing at all.
 */
export const noopErrorReporter: ErrorReporter = {
  report: () => {},
  flush: async () => {},
}

export type RecordedReport = {
  error: unknown
  requestId: string
  context?: Record<string, unknown>
}

/** A reporter that remembers what it was told, for asserting that the 500 path reports. */
export const createRecordingErrorReporter = (): ErrorReporter & {
  readonly reports: readonly RecordedReport[]
  readonly flushes: () => number
} => {
  const reports: RecordedReport[] = []
  let flushes = 0
  return {
    report: (error, { requestId, context }) => {
      reports.push(context === undefined ? { error, requestId } : { error, requestId, context })
    },
    flush: async () => {
      flushes += 1
    },
    reports,
    flushes: () => flushes,
  }
}
