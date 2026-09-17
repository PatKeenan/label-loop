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
 * The trace list.
 *
 * **Org-wide, not panel-scoped, and that is still true at phase 7.** `GET /internal/traces`
 * takes no panel filter; CONSOLE_FLOW §4 gives phase 8 the job of scoping it, on the
 * reasoning that the API is already shaped the easy way round. The screen says so rather
 * than showing an org's rows under a panel's heading without comment.
 */
export const tracesQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['traces', orgId],
    queryFn: async () => {
      const response = await api.internal.traces.$get({ query: {} }, asOrg(orgId))
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.traces
    },
  })
