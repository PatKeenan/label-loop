/**
 * Port #3. Reporting is not handling (ADR-0007): the tracker is the sink at the end of
 * the error pipeline, never a strategy for deciding what the caller sees. It is a port
 * rather than a direct Sentry import so that boot needs no secret, the central handler
 * is testable without a network, and swapping trackers touches one file.
 */
export type ErrorReport = {
  /** The W3C trace id of the execution that failed — the join to its logs and spans. */
  requestId: string
  /** Structured, non-sensitive detail. Never request or response bodies. */
  context?: Record<string, unknown>
}

export type ErrorReporter = {
  report: (error: unknown, report: ErrorReport) => void
  /** Called during graceful shutdown so in-flight reports are not lost on exit. */
  flush: (timeoutMs?: number) => Promise<void>
}
