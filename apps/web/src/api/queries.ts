import { ACTIVE_ORG_HEADER } from '@labelloop/contracts'
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query'
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

/**
 * Which sign-in methods the API accepts — the login screen's doors. Public and org-less: it
 * is asked before anyone is signed in. Effectively static for a running API, so it is never
 * re-asked within a page's life.
 */
export const signInMethodsQuery = queryOptions({
  queryKey: ['sign-in-methods'],
  queryFn: async () => {
    const response = await api.internal['sign-in-methods'].$get()
    if (!response.ok) throw await apiErrorFrom(response)
    return (await response.json()).data
  },
  staleTime: Number.POSITIVE_INFINITY,
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
export const tracesQuery = (orgId: string, panelId: string, limit?: number) =>
  queryOptions({
    // `limit` in the key: the Overview's five and the Traces section's fifty are different
    // answers, and sharing one entry would show one screen the other's page.
    queryKey: ['traces', orgId, panelId, limit ?? 'default'],
    queryFn: async () => {
      const response = await api.internal.traces.$get(
        { query: { panel_id: panelId, ...(limit === undefined ? {} : { limit: String(limit) }) } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.traces
    },
  })

/**
 * The Traces section's list, a page at a time, newest first.
 *
 * KEYSET pages: each page hands back an opaque `next_cursor` meaning "older than my last row",
 * and the next request sends it as `before`. Offsets would drift — traces arrive at the top
 * continuously, so "skip 50" names a different 50 every time a call lands. The Overview's five
 * recent traces stay on `tracesQuery`; they never page.
 */
export const tracePagesQuery = (orgId: string, panelId: string) =>
  infiniteQueryOptions({
    queryKey: ['traces', orgId, panelId, 'pages'],
    queryFn: async ({ pageParam }) => {
      const response = await api.internal.traces.$get(
        { query: { panel_id: panelId, ...(pageParam === null ? {} : { before: pageParam }) } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor,
  })

/**
 * ONE trace, whole — the drawer's read (Deviation 75). Staff-only on the server; the console
 * only ever asks from a staff role's screens.
 */
export const traceDetailQuery = (orgId: string, traceId: string) =>
  queryOptions({
    queryKey: ['trace', orgId, traceId],
    queryFn: async () => {
      const response = await api.internal.traces[':id'].$get(
        { param: { id: traceId } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    // The trace itself never changes after it is written — `recorded_at` is stamped once.
    // Its ANNOTATIONS do, whenever somebody annotates it (M5 phase 6), and a minute-stale
    // answer to "who has looked at this" is the right trade for a drawer opened off a list:
    // the annotator is on another surface, so nobody is watching this for their own write.
    staleTime: 60_000,
  })

/**
 * THE CONSOLE'S ANNOTATION READS (ADR-0084). Staff only — `annotation: ['curate']` on the
 * server — and READ-ONLY with respect to answers: there is no query here that could change one,
 * because nobody annotates somebody else's work.
 */
export const annotationSetsQuery = (orgId: string, panelSlug: string) =>
  queryOptions({
    queryKey: ['annotation-sets', orgId, panelSlug],
    queryFn: async () => {
      const response = await api.internal.panels[':slug']['annotation-sets'].$get(
        { param: { slug: panelSlug } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.sets
    },
  })

/**
 * One set: its annotators with their progress, and its traces with every annotator's answer.
 *
 * Not cached for long, and for a different reason from the queue's reads: this is a view of
 * work somebody ELSE is doing right now, so a minute-stale answer is the wrong thing to show a
 * developer watching progress. The trace's own detail (`traceDetailQuery`) stays at a minute,
 * because the annotator is not watching that.
 */
export const annotationSetQuery = (orgId: string, setId: string) =>
  queryOptions({
    queryKey: ['annotation-set', orgId, setId],
    queryFn: async () => {
      const response = await api.internal['annotation-sets'][':id'].$get(
        { param: { id: setId } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    staleTime: 10_000,
  })

/**
 * The active org's members and open invitations — Organisation settings → Members (ADR-0070).
 * Asked only from an admin's screen; the server guards the read with `member: [read]`.
 */
export const membersQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['members', orgId],
    queryFn: async () => {
      const response = await api.internal.members.$get(undefined, asOrg(orgId))
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
  })

/**
 * THE ANNOTATOR SURFACE'S READS (ADR-0066, ADR-0067, ADR-0079).
 *
 * All three are `annotation: [create]` on the server, which an annotator holds and staff hold
 * too. None is cached beyond the moment: the queue is a SEQUENCE, and a cached "next item" is an
 * item this person may already have answered. `staleTime: 0` and no structural sharing, so
 * asking again always asks the server.
 */

/**
 * THE SETS ASSIGNED TO THIS PERSON, and nothing else (ADR-0079). An empty list is the honest
 * answer for somebody with nothing assigned — there is no panel-wide queue to fall back to.
 */
export const assignedSetsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ['annotate-sets', orgId],
    queryFn: async () => {
      const response = await api.internal.annotate.sets.$get(undefined, asOrg(orgId))
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data.sets
    },
    staleTime: 0,
  })

/**
 * The next item for this person in this set, or why there is none.
 *
 * `nonce` is what advances the queue: answering increments it, which changes the key, which
 * asks the server for a new item. A refetch of the same key would be a retry of the same
 * question — and the server, which has just recorded an answer, would give a different answer
 * to it anyway. Making the advance explicit keeps "what am I looking at" a value rather than
 * a race between a mutation and a refetch.
 */
export const annotateNextQuery = (orgId: string, setId: string, nonce: number) =>
  queryOptions({
    queryKey: ['annotate-next', orgId, setId, nonce],
    queryFn: async () => {
      const response = await api.internal.annotate.sets[':id'].next.$get(
        { param: { id: setId } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    staleTime: 0,
    gcTime: 0,
  })

/**
 * The last thing this person answered in this set, for the one step back.
 *
 * Asked only when the Back control is used, and never cached: the answer behind you changes
 * every time you save. `enabled: false` at the call site, fetched on demand.
 */
export const annotatePreviousQuery = (orgId: string, setId: string) =>
  queryOptions({
    queryKey: ['annotate-previous', orgId, setId],
    queryFn: async () => {
      const response = await api.internal.annotate.sets[':id'].previous.$get(
        { param: { id: setId } },
        asOrg(orgId),
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    staleTime: 0,
    gcTime: 0,
  })
