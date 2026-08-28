import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from '../../app-env.ts'
import { AUTH_BASE_PATH } from '../../auth.ts'
import { sessionAuth } from '../../middleware/session.ts'
import { createMeRoutes } from './me.ts'
import { createTraceRoutes } from './traces.ts'

/**
 * The internal console surface (CONVENTIONS.md "Directory shape").
 *
 * It is deliberately NOT `/v1`. `/v1` is a versioned public contract with an OpenAPI
 * document, a closed error taxonomy and a promise that a breaking change means a new
 * version; this surface is consumed by exactly one client that ships in the same repo, so
 * its contract is Hono's RPC types (ADR-0002 rules out an SDK, not type inference). A
 * console route can change shape and `apps/web` fails to compile, which is a stronger
 * guarantee than a hand-written schema and cannot drift from the handler.
 *
 * **Registration order in this file is load-bearing**, so it reads top to bottom as the
 * three things that happen to an internal request:
 *
 * 1. **CORS**, first, because the console is a different origin in development and a
 *    preflight has to be answered before anything else looks at the request.
 * 2. **better-auth's own endpoints**, unguarded — signing in cannot require being signed
 *    in. They are registered BEFORE the guard, so a request to `/internal/auth/*` is
 *    answered by the handler and the session middleware below never runs for it.
 * 3. **The guard, then everything else.** Every route added after `sessionAuth()` is
 *    protected by construction: forgetting is not an option that exists, because there is
 *    nowhere else to add one.
 */

/**
 * The console's cross-origin policy: one origin, and credentials.
 *
 * `credentials: true` is what lets the session cookie ride along, and it is precisely why
 * the origin is an exact match against configuration rather than a reflection of whatever
 * `Origin` header arrived — a wildcard with credentials is the shape that turns any page a
 * user visits into a client of this API.
 */
const consoleCors = () =>
  cors({
    origin: (origin, c) => (origin === c.var.deps.config.WEB_ORIGIN ? origin : undefined),
    credentials: true,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type'],
  })

/** The mount point, and the prefix `AUTH_BASE_PATH` must agree with. */
export const INTERNAL_BASE_PATH = '/internal'

const AUTH_ROUTE = `${AUTH_BASE_PATH.slice(INTERNAL_BASE_PATH.length)}/*`

export const createInternalRoutes = () => {
  const internal = new Hono<AppEnv>()

  internal.use('*', consoleCors())
  // Handed the RAW request: better-auth owns its own routing, cookies and status codes
  // below this path, and re-deriving any of that here would be a second implementation of
  // the library we chose.
  internal.on(['GET', 'POST'], AUTH_ROUTE, (c) => c.var.deps.auth.handler(c.req.raw))
  internal.use('*', sessionAuth())

  // Chained, because the chain IS the type `apps/web` consumes over RPC.
  return internal.route('/', createMeRoutes()).route('/', createTraceRoutes())
}
