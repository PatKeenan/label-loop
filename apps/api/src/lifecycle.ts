import type { RootLogger } from './middleware/logger.ts'
import type { ErrorReporter } from './ports/error-reporter.ts'

/**
 * Graceful shutdown is a feature with a test, not an afterthought (CONVENTIONS.md
 * "Health & lifecycle"). The order is the whole point:
 *
 * 1. **Stop accepting** new connections — the orchestrator has already removed us from
 *    rotation, and anything arriving now would be killed mid-flight.
 * 2. **Drain in-flight work** — `server.stop(false)` resolves once open requests finish.
 *    Passing `true` would sever them, which is the bug this function exists to avoid.
 * 3. **Flush telemetry** — an error that caused the shutdown is exactly the one you need
 *    reported, and it is still sitting in a buffer.
 * 4. **Exit 0** — a clean exit, so the orchestrator does not record a crash loop.
 *
 * P5 extends step 2 to drain in-flight *jobs* as well as requests.
 */
export type ShutdownDeps = {
  /** Structurally the part of `Bun.Server` shutdown needs, so tests can pass a stub. */
  server: { stop: (closeActiveConnections?: boolean) => Promise<void> }
  errorReporter: ErrorReporter
  logger: RootLogger
  /** How long telemetry gets to flush before we stop waiting for it. */
  flushTimeoutMs?: number
}

export const gracefulShutdown = async (
  signal: string,
  { server, errorReporter, logger, flushTimeoutMs = 2_000 }: ShutdownDeps,
): Promise<void> => {
  logger.info({ signal }, 'shutdown started')
  await server.stop(false)
  logger.info({ signal }, 'in-flight requests drained')
  await errorReporter.flush(flushTimeoutMs)
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
