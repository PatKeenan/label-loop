import type { RootLogger } from './middleware/logger.ts'
import type { ErrorReporter } from './ports/error-reporter.ts'

/**
 * Graceful shutdown is a feature with a test, not an afterthought (CONVENTIONS.md
 * "Health & lifecycle"). The order is the whole point:
 *
 * 1. **Stop accepting** new connections — the orchestrator has already removed us from
 *    rotation, and anything arriving now would be killed mid-flight.
 * 2. **Drain in-flight requests** — `server.stop(false)` resolves once open requests
 *    finish. Passing `true` would sever them, which is the bug this function exists to
 *    avoid.
 * 3. **Drain in-flight jobs** — after the requests, not with them: a request still being
 *    served can enqueue a job, so stopping the queue first would drop work created by the
 *    very requests step 2 is protecting. Jobs still running when the timeout expires are
 *    released back to the queue rather than lost, which is what makes them retryable work
 *    rather than a deadline.
 * 4. **Flush telemetry** — an error that caused the shutdown, or a job that failed while
 *    draining, is exactly the one you need reported, and it is still sitting in a buffer.
 *    Both buffers: the error reporter's, and the span batch processor's. A shutdown is
 *    when the last five seconds of spans are most worth having and most easily lost,
 *    because a batch processor's whole job is to not send yet.
 * 5. **Close the database pool** — after draining, never before: a request in flight at
 *    step 2 and a job in flight at step 3 both need their connections, and closing early
 *    would fail the very work the drain exists to protect.
 * 6. **Exit 0** — a clean exit, so the orchestrator does not record a crash loop.
 */
export type ShutdownDeps = {
  /** Structurally the part of `Bun.Server` shutdown needs, so tests can pass a stub. */
  server: { stop: (closeActiveConnections?: boolean) => Promise<void> }
  errorReporter: ErrorReporter
  logger: RootLogger
  /**
   * Structurally the part of the queue shutdown needs. Optional for the same reason `db`
   * is: the lifecycle tests are about ordering, not about pg-boss.
   */
  jobs?: { stop: () => Promise<void> }
  /**
   * Structurally the part of the database handle shutdown needs. Optional so the
   * lifecycle tests — which are about ordering, not about Postgres — stay free of one.
   */
  db?: { close: () => Promise<void> }
  /**
   * Structurally the part of the OTel SDK shutdown needs — `shutdown()` force-flushes the
   * batch processor and then stops it. Optional for the same reason `db` and `jobs` are:
   * the lifecycle tests are about ordering, not about OpenTelemetry.
   */
  telemetry?: { shutdown: () => Promise<void> }
  /** How long telemetry gets to flush before we stop waiting for it. */
  flushTimeoutMs?: number
}

export const gracefulShutdown = async (
  signal: string,
  { server, errorReporter, logger, db, jobs, telemetry, flushTimeoutMs = 2_000 }: ShutdownDeps,
): Promise<void> => {
  logger.info({ signal }, 'shutdown started')
  await server.stop(false)
  logger.info({ signal }, 'in-flight requests drained')
  if (jobs !== undefined) {
    await jobs.stop()
    logger.info({ signal }, 'in-flight jobs drained')
  }
  await errorReporter.flush(flushTimeoutMs)
  if (telemetry !== undefined) {
    // Deliberately not fatal. A collector that is down must not turn a clean shutdown into
    // a non-zero exit, which an orchestrator reads as a crash loop — the spans are the
    // thing being lost, and losing them louder does not bring them back.
    await telemetry.shutdown().catch((error: unknown) => {
      logger.warn({ signal, err: error }, 'telemetry shutdown failed')
    })
    logger.info({ signal }, 'telemetry flushed')
  }
  if (db !== undefined) {
    await db.close()
    logger.info({ signal }, 'database pool closed')
  }
  logger.info({ signal }, 'shutdown complete')
}

/** Wire the signals a container runtime actually sends. */
export const installSignalHandlers = (
  deps: ShutdownDeps,
  exit: (code: number) => void = process.exit,
): (() => void) => {
  let shuttingDown = false
  const handlers = (['SIGTERM', 'SIGINT'] as const).map((signal) => {
    const handler = () => {
      // A second signal during shutdown must not start a second drain.
      if (shuttingDown) return
      shuttingDown = true
      void gracefulShutdown(signal, deps).then(
        () => exit(0),
        (error: unknown) => {
          deps.logger.error({ signal, err: error }, 'shutdown failed')
          exit(1)
        },
      )
    }
    process.on(signal, handler)
    return [signal, handler] as const
  })

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}
