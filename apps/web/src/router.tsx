import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { LoginRoute } from './routes/login.tsx'
import { RootLayout } from './routes/root.tsx'
import { TracesPage } from './routes/traces.tsx'

/**
 * The route tree, defined in code rather than by file convention.
 *
 * TanStack Router's file-based routing generates a route tree into the source directory,
 * and generated files in the repo are what this project has consistently declined —
 * `packages/db`'s auth tables are hand-written and drift-tested for the same reason. Two
 * routes do not need a code generator, and if the console grows to twenty this becomes a
 * decision to revisit with an ADR rather than a default nobody chose.
 */

const rootRoute = createRootRoute({ component: RootLayout })

const tracesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: TracesPage,
})

/**
 * A route of its own as well as the signed-out branch of `/`, so that "sign in" is a place
 * you can be sent to, which M4's real redirect-after-401 will need.
 *
 * `LoginRoute`, not `LoginPage`: the route bounces an already-signed-in visitor to the
 * trace list, while the bare form stays reusable as the signed-out branch of `/`.
 */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRoute,
})

export const router = createRouter({ routeTree: rootRoute.addChildren([tracesRoute, loginRoute]) })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
