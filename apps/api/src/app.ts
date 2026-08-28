import { type Context, Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppDeps, AppEnv } from './app-env.ts'
import { mountDocs } from './docs.ts'
import { AppError, toAppError } from './errors.ts'
import { createRootLogger, httpLogger, type RootLogger } from './middleware/logger.ts'
import { currentRequestId, REQUEST_ID_KEY, requestContext } from './middleware/request-context.ts'
import { tracing } from './middleware/tracing.ts'
import { createDemoErrorRoutes } from './routes/demo-errors.ts'
import { createHealthRoutes } from './routes/health.ts'
import { createInternalRoutes, INTERNAL_BASE_PATH } from './routes/internal/index.ts'
import { createV1Routes } from './routes/public/v1/index.ts'

/**
 * The composition root. Everything external is passed in, so an integration test builds
 * the *real* app around fakes rather than reaching inside it (CONVENTIONS.md
 * "Dependency seams"). It exists from P2, before the dependency list is interesting,
 * because retrofitting a seam after routes exist means rewriting every route.
 */

/**
 * The single place an error becomes a response. Route handlers throw; nothing else in
 * this codebase constructs an error body (CONVENTIONS.md "Error handling").
 */
const renderError = (
  error: unknown,
  c: Context<AppEnv>,
  deps: AppDeps,
  rootLogger: RootLogger,
): Response => {
  const { appError, unexpected } = toAppError(error)
  // The middleware that sets these runs first, but an error thrown *by* it would arrive
  // here before they exist — so the handler that must never fail does not assume they do.
  const requestId = (c.get(REQUEST_ID_KEY) as string | undefined) ?? currentRequestId()
  const lines = c.get('logger') ?? rootLogger

  if (unexpected) {
    // Reporting is not handling (ADR-0007): the tracker is told, and the caller still
    // gets exactly the envelope every other failure gets.
    deps.errorReporter.report(appError.cause ?? appError, {
      requestId,
      context: { code: appError.code, path: c.req.path },
    })
    lines.error(
      { request_id: requestId, code: appError.code, err: appError.cause },
      'unhandled error',
    )
  }

  return c.json(
    {
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.issues === undefined ? {} : { issues: appError.issues }),
      },
      request_id: requestId,
    },
    appError.status as ContentfulStatusCode,
    appError.retryAfterSeconds === undefined
      ? {}
      : { 'retry-after': String(appError.retryAfterSeconds) },
  )
}

export const createApp = (deps: AppDeps) => {
  const rootLogger = createRootLogger(deps.config)

  const app = new Hono<AppEnv>()

  // Order matters, and P6 added a step at the front. Tracing is outermost so its span
  // covers the entire execution INCLUDING the error handler; then deps, so everything
  // downstream can read them; then the request id, which is now READ from the span
  // tracing just started, so the logger and the envelope quote the trace id itself; then
  // logging, so it observes the whole request.
  app.use('*', tracing(deps.tracer))
  app.use('*', async (c, next) => {
    c.set('deps', deps)
    await next()
  })
  app.use('*', requestContext())
  app.use('*', httpLogger(rootLogger))

  const v1 = createV1Routes()
  mountDocs(v1, deps.config)

  // Chained, and that is not style: `app.route()` returns the app with the mounted routes
  // MERGED INTO ITS TYPE, and that accumulated type is what `hc<AppType>` in `apps/web`
  // turns into a typed client. Writing these as separate statements throws the type away
  // and the console's calls silently become untyped.
  //
  // The two surfaces are mounted side by side and share nothing but this line. `/v1` is
  // authenticated by a hashed panel-scoped API key; `/internal` by a session cookie. Neither
  // middleware can see the other's credential, so the separation is structural rather than
  // a rule someone has to follow (CONVENTIONS.md "Keys & auth").
  const routes = app
    .route('/', createHealthRoutes())
    .route('/', createDemoErrorRoutes())
    .route(INTERNAL_BASE_PATH, createInternalRoutes())
    .route('/v1', v1)

  app.notFound((c) =>
    renderError(new AppError('NOT_FOUND', 'No route matches this path.'), c, deps, rootLogger),
  )
  app.onError((error, c) => renderError(error, c, deps, rootLogger))

  return routes
}

/**
 * The type `apps/web` consumes over Hono RPC — the whole point of the chain above.
 *
 * No codegen and no published schema: the console imports this type straight out of the
 * API's source, so a route that changes shape breaks the console's typecheck in the same
 * commit rather than at runtime in someone's browser (ADR-0002 rules out an SDK for
 * CUSTOMERS; this client ships in the same repo and is not one).
 */
export type AppType = ReturnType<typeof createApp>
