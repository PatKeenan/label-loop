import type { PinoLogger } from 'hono-pino'
import type { Config } from './config.ts'
import type { Clock } from './ports/clock.ts'
import type { ErrorReporter } from './ports/error-reporter.ts'

/**
 * Everything the app needs from the outside world, wired once at composition
 * (`createApp(deps)`) and never imported ad hoc. No DI container: the seam is the value,
 * not the framework (CONVENTIONS.md "Dependency seams").
 *
 * P4 adds `modelProvider`, P3 a database handle. The list growing is the point — each
 * addition is a thing tests can substitute rather than monkey-patch.
 */
export type AppDeps = {
  config: Config
  clock: Clock
  errorReporter: ErrorReporter
}

/** The Hono environment: what lives on `c.var` for every request. */
export type AppEnv = {
  Variables: {
    deps: AppDeps
    requestId: string
    logger: PinoLogger
  }
}
