import { ACTIVE_ORG_HEADER } from '@labelloop/contracts'
import { queryOptions } from '@tanstack/react-query'
import { apiErrorFrom } from '../errors/api-error.ts'
import { api } from './client.ts'

/**
 * The console's reads, defined once so a component never assembles a query key by hand.
 *
 * Note what is NOT here: any type annotation for what comes back. The shapes are inferred
 * from the API's route handlers through `hc<AppType>`, so hovering `traces` in a component
 * shows the fields the server actually returns. That is the end-to-end inference the
 * arrangement exists for — if it were annotated here, the annotation is what would drift.
 *
 * ---
 *
 * **EVERY ORG-SCOPED READ TAKES AN `orgId`, AND IT IS IN THE QUERY KEY.** That is not
 * ceremony. `sessionAuth` resolves the active org from the `X-LabelLoop-Org` header and
 * filters every row by it (ADR-0047), so two orgs give the same URL two different answers —
 * and a cache keyed on the URL alone would serve one org's rows under the other's heading
 * the moment the switcher is used. The org in the key is what makes switching a different
 * question rather than a stale answer to the same one.
 */

/** Sends the active org, exactly as `sessionAuth` expects to read it. */
const asOrg = (orgId: string) => ({ headers: { [ACTIVE_ORG_HEADER]: orgId } })

/**
 * Who is signed in, every org they may see, and the one the server picks when asked for
 * none. `null` means signed out.
 *
 * **Deliberately sends no org header.** This is the bootstrap read: it is what TELLS the
 * console which orgs exist, so it cannot be scoped by one of them without a chicken-and-egg.
 * Its `memberships` are then what resolves an org slug in the URL to the id every other read
 * sends — and what makes an unknown slug a not-found state rather than a silent fallback
 * (ADR-0057, and the 6b shell's decision 9).
 *
 * `active_org_id` is the server's fallback choice, and the console cannot derive it: with no
 * header sent, `sessionAuth` takes the first membership, and reproducing that would mean
 * reimplementing the ordering rule and trusting it matches.
 */
export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async () => {
    const response = await api.internal.me.$get()
    // 401 is not an error condition here, it is the answer: nobody is signed in. Throwing
    // would make the router's "show the login form" path go through an error boundary.
    if (response.status === 401) return null
    if (!response.ok) throw await apiErrorFrom(response)
    return (await response.json()).data
  },
  // A session can end server-side (expiry, sign-out in another tab) without this tab
  // hearing about it, so the answer is re-checked when the tab is focused rather than
  // cached indefinitely.
  staleTime: 30_000,
})

/** Every panel in the active org — the panel switcher's contents, and Home's list. */
export const panelsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['panels', orgId],
    queryFn: async () => {
      const response = await api.internal.panels.$get(undefined, asOrg(orgId))
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.panels
    },
  })

/**
 * ONE panel — its Overview and its Judges section, which are two views of the same object
 * and so are one read. Addressed by SLUG, because that is what the URL carries.
 */
export const panelQuery = (orgId: string, slug: string) =>
  queryOptions({
    queryKey: ['panel', orgId, slug],
    queryFn: async () => {
      const response = await api.internal.panels[':slug'].$get({ param: { slug } }, asOrg(orgId))
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
  })

/**
 * Every key in the active org.
 *
 * **Org-wide, and the Keys screen filters by panel.** `GET /internal/keys` is not
 * panel-scoped, and CONSOLE_FLOW §4 is explicit that the API is shaped the easy way round on
 * purpose: scoping it later is a narrowing, where widening a panel-scoped read would not be.
 * Filtering in the client is correct HERE and not for traces — a key list is bounded by how
 * many credentials an org has issued, where a trace list is unbounded and paginated, so
 * filtering a page of traces would silently drop rows.
 */
export const keysQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['keys', orgId],
    queryFn: async () => {
      const response = await api.internal.keys.$get(undefined, asOrg(orgId))
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.keys
    },
  })

/**
 * ONE panel's trace list — the Traces section of the panel open in the URL.
 *
 * Scoped by the SERVER, on `panel_id` (M4 phase 8), never filtered here: the list is
 * paginated and unbounded, so filtering a page of an org's traces in the browser would
 * silently drop rows — the reason `keysQuery` above can filter client-side and this cannot.
 * The panel is in the query key for the same reason the org is: two panels give the same URL
 * shape two different answers.
 */
export const tracesQuery = (orgId: string, panelId: string) =>
  queryOptions({
    queryKey: ['traces', orgId, panelId],
    queryFn: async () => {
      const response = await api.internal.traces.$get(
        { query: { panel_id: panelId } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.traces
    },
  })
