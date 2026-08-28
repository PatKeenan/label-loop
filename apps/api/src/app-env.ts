import type { Database } from '@labelloop/db'
import type { PinoLogger } from 'hono-pino'
import type { Config } from './config.ts'
import type { JobQueue } from './jobs/index.ts'
import type { ModelGateway } from './llm/index.ts'
import type { AuthenticatedKey } from './middleware/api-key-auth.ts'
import type { Clock } from './ports/clock.ts'
import type { ErrorReporter } from './ports/error-reporter.ts'

/**
 * Everything the app needs from the outside world, wired once at composition
 * (`createApp(deps)`) and never imported ad hoc. No DI container: the seam is the value,
 * not the framework (CONVENTIONS.md "Dependency seams").
 *
 * P4 adds `modelGateway`; P5 adds `jobs`. The list growing is the point — each addition is
 * a thing tests can substitute rather than monkey-patch.
 */
export type AppDeps = {
  config: Config
  clock: Clock
  errorReporter: ErrorReporter
  /** The APP role's handle: DML only. Nothing here can migrate or alter schema (P3). */
  db: Database
  /**
   * The provider gateway, composed around a `ModelProvider` in `server.ts`. The GATEWAY is
   * injected rather than the raw port because it is stateful — its circuit breakers
   * remember what happened on the last request, and a breaker rebuilt per request would
   * never open. M1 swaps the adapter underneath it and nothing here changes.
   */
  modelGateway: ModelGateway
  /**
   * The queue, behind its own port (ADR-0006/ADR-0017). Injected rather than imported for
   * the same reason as the gateway: it holds a connection pool and a poller, so a test that
   * wants neither passes something that has neither.
   */
  jobs: JobQueue
}

/** The Hono environment: what lives on `c.var` for every request. */
export type AppEnv = {
  Variables: {
    deps: AppDeps
    requestId: string
    logger: PinoLogger
    /**
     * The key that authorised this request. Set by `apiKeyAuth`, so it is present only on
     * routes behind that middleware — which is every route that reads it.
     */
    apiKey: AuthenticatedKey
  }
}
