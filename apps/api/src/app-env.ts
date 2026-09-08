import type { Database } from '@labelloop/db'
import type { Tracer } from '@opentelemetry/api'
import type { PinoLogger } from 'hono-pino'
import type { Auth } from './auth.ts'
import type { Config } from './config.ts'
import type { JobQueue } from './jobs/index.ts'
import type { ModelGateway } from './llm/index.ts'
import type { AuthenticatedKey } from './middleware/api-key-auth.ts'
import type { AuthenticatedSession } from './middleware/session.ts'
import type { Clock } from './ports/clock.ts'
import type { ErrorReporter } from './ports/error-reporter.ts'
import type { RateLimitStore } from './ports/rate-limit-store.ts'

/**
 * Everything the app needs from the outside world, wired once at composition
 * (`createApp(deps)`) and never imported ad hoc. No DI container: the seam is the value,
 * not the framework (CONVENTIONS.md "Dependency seams").
 *
 * P4 adds `modelGateway`; P5 adds `jobs`; P6 adds `tracer`; P7 adds `auth`. The list
 * growing is the point
 * — each addition is a thing tests can substitute rather than monkey-patch.
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
  /**
   * Where spans come from (ADR-0007). Injected rather than taken from OTel's global,
   * which is a process-wide singleton that may only be set once — so a test asserting on
   * real spans would otherwise have to mutate global state and leak it into every test
   * file that ran afterwards. `server.ts` passes the started SDK's tracer; a test passes
   * one from a provider it owns, or the API's no-op default when it does not care.
   */
  tracer: Tracer
  /**
   * better-auth (ADR-0008), configured at P3 and mounted here at P7. Injected rather than
   * constructed inside the app because it holds the database handle and the signing secret
   * — so a test that wants a different secret, or no database, passes a different one.
   *
   * It serves the CONSOLE only. Nothing on the `/v1` path touches it, and nothing it issues
   * grants access there (CONVENTIONS.md "Keys & auth").
   */
  auth: Auth
  /**
   * Where the rate limiter's counters live (ADR-0038). Injected rather than constructed in
   * the middleware for the same reason the gateway is: it is STATEFUL — it is nothing but
   * state — and one rebuilt per request would hold a fresh empty bucket every time, which
   * is to say it would never limit anything.
   *
   * The port, not Redis, so a test passes the in-memory peer and M2's phase 3 can reverse
   * the store choice without touching anything above this line (ADR-0039).
   */
  rateLimitStore: RateLimitStore
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
    /**
     * Who is signed in, and which org they may see. Set by `sessionAuth`, so it is present
     * only on routes behind that middleware — which is every internal route except
     * better-auth's own, since signing in cannot require being signed in.
     */
    session: AuthenticatedSession
  }
}
