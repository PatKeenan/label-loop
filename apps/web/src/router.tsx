import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { validateConsoleSearch } from './components/shell/context.ts'
import { HomePage } from './routes/home.tsx'
import { LoginRoute } from './routes/login.tsx'
import { PanelKeysPage, PanelOverviewPage } from './routes/panel.tsx'
import { ConsoleLayout, RootLayout } from './routes/root.tsx'
import { TracesPage } from './routes/traces.tsx'

/**
 * The route tree, defined in code rather than by file convention.
 *
 * TanStack Router's file-based routing generates a route tree into the source directory,
 * and generated files in the repo are what this project has consistently declined —
 * `packages/db`'s auth tables are hand-written and drift-tested for the same reason. Six
 * routes still do not need a code generator, and if the console grows past a dozen this
 * becomes a decision to revisit with an ADR rather than a default nobody chose.
 *
 * ---
 *
 * **THE URL IS WHERE BOTH CONTEXTS LIVE** (ADR-0047, CONSOLE_FLOW §4, and the shape is this
 * phase's — see `components/shell/context.ts` for the reasoning):
 *
 *     /                        Home, in the account's default org
 *     /p/$panelSlug            that panel's Overview
 *     /p/$panelSlug/traces     …its sections
 *     /p/$panelSlug/keys
 *     ?org=acme-support        on any of the above
 *
 * `org` is validated on the ROOT route, so every route in the tree inherits it and a single
 * definition covers the whole console. It is a search param rather than a path segment
 * because it re-scopes whatever screen you are on rather than naming a different one.
 */

const rootRoute = createRootRoute({
  component: RootLayout,
  validateSearch: validateConsoleSearch,
})

/**
 * Pathless. Its only job is to put the shell around everything except `/login` — there is
 * nothing to navigate when signed out, so the login screen must not be inside it.
 *
 * Being a layout route rather than a wrapper each screen renders is what makes the shell
 * mount ONCE and survive navigation between sections, which is the structural version of
 * 6b decision 1 ("the sidebar never swaps its contents").
 */
const consoleRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: 'console',
  component: ConsoleLayout,
})

const homeRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/',
  component: HomePage,
})

/** A panel opens on its Overview — its home, and at M4 its onboarding (ADR-0060 at M4). */
const panelRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/p/$panelSlug',
  component: PanelOverviewPage,
})

const panelTracesRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/p/$panelSlug/traces',
  component: TracesPage,
})

const panelKeysRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/p/$panelSlug/keys',
  component: PanelKeysPage,
})

/**
 * A route of its own as well as the signed-out branch of the console layout, so that "sign
 * in" is a place you can be sent to, which phase 8's real redirect-after-401 will need.
 *
 * `LoginRoute`, not `LoginPage`: the route bounces an already-signed-in visitor to Home,
 * while the bare form stays reusable as the layout's signed-out branch.
 */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: LoginRoute,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    consoleRoute.addChildren([homeRoute, panelRoute, panelTracesRoute, panelKeysRoute]),
    loginRoute,
  ]),
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
