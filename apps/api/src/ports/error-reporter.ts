/**
 * Port #3. Reporting is not handling (ADR-0007): the tracker is the sink at the end of
 * the error pipeline, never a strategy for deciding what the caller sees. It is a port
 * rather than a direct Sentry import so that boot needs no secret, the central handler
 * is testable without a network, and swapping trackers touches one file.
 */
export type ErrorReport = {
  /**
   * The W3C trace id of the execution that failed — the join to its logs and spans.
   *
   * Optional for exactly one case, and it is worth naming rather than leaving to be
   * discovered: an error raised OUTSIDE any request. The queue's supervisor fails on its
   * own timer with no request behind it (P5), and inventing an id there would produce a
   * tag that joins to nothing, which is worse than an absent one. Everything on the
   * request path still passes it, and the type is not the thing keeping that true.
   */
  requestId?: string
  /** Structured, non-sensitive detail. Never request or response bodies. */
  context?: Record<string, unknown>
}

export type ErrorReporter = {
  report: (error: unknown, report: ErrorReport) => void
  /** Called during graceful shutdown so in-flight reports are not lost on exit. */
  flush: (timeoutMs?: number) => Promise<void>
}
