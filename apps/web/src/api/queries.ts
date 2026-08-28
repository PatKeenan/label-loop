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
 */

/** Who is signed in, and which org they may see. `null` means signed out. */
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

export const tracesQuery = queryOptions({
  queryKey: ['traces'],
  queryFn: async () => {
    const response = await api.internal.traces.$get({ query: {} })
    if (!response.ok) throw await apiErrorFrom(response)
    return (await response.json()).data.traces
  },
})
