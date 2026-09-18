import type { QueryClient } from '@tanstack/react-query'
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
} from '@tanstack/react-router'
import { meQuery, signInMethodsQuery } from './api/queries.ts'
import { queryClient } from './api/query-client.ts'
import { safeRedirect } from './api/redirect.ts'
import { validateConsoleSearch } from './components/shell/context.ts'
import { HomePage } from './routes/home.tsx'
import { PanelKeysPage } from './routes/keys.tsx'
import { LoginRoute } from './routes/login.tsx'
import { PanelJudgesPage, PanelOverviewPage } from './routes/panel.tsx'
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
 *     ?new                     the create-panel dialog, over whatever is underneath
 *     /p/$panelSlug            that panel's Overview
 *     /p/$panelSlug/judges     …its sections
 *     /p/$panelSlug/traces
 *     /p/$panelSlug/keys
 *     ?org=acme-support        on any of the above
 *
 * `org` is validated on the ROOT route, so every route in the tree inherits it and a single
 * definition covers the whole console. It is a search param rather than a path segment
 * because it re-scopes whatever screen you are on rather than naming a different one.
 */

/**
 * **THE ROUTER'S CONTEXT IS THE QUERY CLIENT**, so a `beforeLoad` can ask who is signed in
 * before a screen renders — which is what lets "signed out" be a REDIRECT with somewhere to
 * come back to, rather than a login form drawn in place of whatever you asked for. Phase 7
 * declined the context because one redirect did not earn it; redirect-after-401 does.
 */
type RouterContext = { queryClient: QueryClient }

/**
 * Who is signed in, as a `beforeLoad` needs to know it: the session, `null` for nobody, or
 * `undefined` when the question itself failed.
 *
 * A FAILED read is not "signed out". It is a member of no org (`FORBIDDEN`, which the layout
 * draws as its own state) or an API that did not answer — and redirecting either to a login
 * form would ask someone who IS signed in to sign in again. So a failure decides nothing
 * here, and the layout, which reads the same cached query, draws what it is.
 */
const sessionOf = (context: RouterContext) =>
  context.queryClient.ensureQueryData(meQuery).catch(() => undefined)

const rootRoute = createRootRouteWithContext<RouterContext>()({
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
  /**
   * REDIRECT-AFTER-401. Signed out, every console route sends you to `/login` carrying the
   * page you asked for, and signing in brings you back to it — `?org=` and all, because
   * `location.href` is the path WITH its search.
   *
   * The guard is still the SERVER's (`sessionAuth` on `/internal/*`); this is only what the
   * browser does about its answer. A session that ends while a screen is open arrives by the
   * other door — a 401 from any read, handled in `api/query-client.ts` — and ends here too.
   */
  beforeLoad: async ({ context, location }) => {
    if ((await sessionOf(context)) === null) {
      throw redirect({ to: '/login', search: { redirect: location.href } })
    }
  },
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

/** Read-only and locked at M4 — authoring lands at M6, beside the taxonomy (ADR-0061). */
const panelJudgesRoute = createRoute({
  getParentRoute: () => consoleRoute,
  path: '/p/$panelSlug/judges',
  component: PanelJudgesPage,
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
 * Where "signed out" sends you. `?redirect=` is where to go afterwards, validated as a path
 * on this origin by `safeRedirect` — anything else is dropped, and absent means Home.
 *
 * Arriving here already signed in goes straight to that target: there is nothing to sign in
 * to, and showing the form would invite someone to type credentials nothing will check.
 */
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  // The key is RETURNED as `undefined`, not omitted: the router merges this over the raw query
  // string, so an omitted key keeps the unvalidated value — which made the first version of
  // this check a no-op (see `validateConsoleSearch`). `safeRedirect` runs again where the value
  // is used, so neither place alone is what keeps it safe.
  validateSearch: ({
    redirect: target,
  }: Record<string, unknown>): { redirect?: string | undefined } => ({
    redirect: safeRedirect(target),
  }),
  beforeLoad: async ({ context, search }) => {
    const session = await sessionOf(context)
    if (session !== null && session !== undefined) {
      throw redirect({ href: safeRedirect(search.redirect) ?? '/', replace: true })
    }
    // Asked here, alongside the session, so the form does not render a loading line and then
    // redraw with a different set of doors. `prefetch` never throws; the screen shows a failure.
    await context.queryClient.prefetchQuery(signInMethodsQuery)
  },
  component: LoginRoute,
})

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    consoleRoute.addChildren([
      homeRoute,
      panelRoute,
      panelJudgesRoute,
      panelTracesRoute,
      panelKeysRoute,
    ]),
    loginRoute,
  ]),
  context: { queryClient },
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
