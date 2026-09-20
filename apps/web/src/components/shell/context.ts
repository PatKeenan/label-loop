import { useQuery } from '@tanstack/react-query'
import { useParams, useSearch } from '@tanstack/react-router'
import { meQuery, panelsQuery } from '../../api/queries.ts'

/**
 * WHICH ORG AND WHICH PANEL THIS VIEW IS ABOUT.
 *
 * CONSOLE_FLOW §4 states the rule and leaves the shape to this phase: *"Both contexts live
 * in the URL, not in storage."* The reasoning is ADR-0047's own — a server-side or
 * `localStorage` "active org" lets a second tab silently change what the first is showing,
 * and a URL makes each tab its own context and makes a link shareable.
 *
 * **The shape chosen here** (M4 phase 7):
 *
 *     /                              Home, in the account's default org
 *     /p/$panelSlug                  that panel's Overview
 *     /p/$panelSlug/traces           …its sections
 *     ?org=acme-support              on ANY of the above
 *
 * The org is a SEARCH PARAM rather than a path segment because it is orthogonal to
 * everything else: it re-scopes whatever screen you are on rather than naming a different
 * screen, and every path above is meaningful in any org the account belongs to. One
 * `validateSearch` on the root route therefore covers the whole tree, and omitting it means
 * "the account's default", which is a real answer rather than a missing one.
 *
 * **The URL carries the org's SLUG; the wire carries its ID.** `X-LabelLoop-Org` is
 * validated against membership ids, and a slug in a URL is what a person can read and
 * share. The two are bridged with no extra round trip because `GET /internal/me` already
 * returns `memberships` with both — the join Deviation 2 added for exactly this.
 */

/** What the root route accepts in the query string. */
export type ConsoleSearch = {
  org?: string | undefined
  /**
   * The create-panel dialog, open.
   *
   * In the URL rather than in component state because it has TWO triggers — Home's button and
   * the panel switcher's menu item, which live in different trees — and because it then costs
   * nothing to get right: the back button closes it, a reload keeps it, and the link is
   * shareable. It is the same reasoning ADR-0047 gives for the org and the panel, applied to
   * the one piece of view state that has more than one way in.
   */
  new?: true | undefined
  /**
   * The trace open in the drawer (Deviation 75), on the Traces section or the Overview. In the
   * URL for the same reasons as `new`: back closes it, reload keeps it, and a link to one trace
   * is shareable — which is most of the point of being able to look at one.
   */
  trace?: string | undefined
}

/**
 * **Every key is returned, `undefined` when absent — never omitted.** TanStack Router MERGES a
 * validator's result over the raw parsed query string (`{ ...raw, ...validated }`), so a key
 * this function leaves out keeps whatever the URL said. The first version spread conditionally,
 * which read as "drop it" and did nothing: `?org=` reached `useConsoleContext` as `''` and drew
 * the not-a-member state the comment below exists to prevent. Found in phase 8, when the login
 * route's redirect check turned out to be a no-op for the same reason.
 */
export const validateConsoleSearch = ({
  org,
  new: isNew,
  trace,
}: Record<string, unknown>): ConsoleSearch => ({
  // A trace id or nothing — anything else would only produce a not-found drawer.
  trace: typeof trace === 'string' && trace.startsWith('tr_') ? trace : undefined,
  // An empty `?org=` is treated as absent rather than as a slug nothing matches, so a client
  // that builds the URL from an unset value lands on the default org instead of on a
  // not-found state that blames the person for a bug in a link.
  org: typeof org === 'string' && org !== '' ? org : undefined,
  // Present in any truthy spelling — `?new`, `?new=1`, `?new=true` — because a hand-typed URL
  // should do the obvious thing. (The router's parser turns `?new=true` into a boolean and
  // `?new=1` into a number, so the checks cover both forms.)
  new:
    isNew === true || isNew === 'true' || isNew === 1 || isNew === '1' || isNew === ''
      ? true
      : undefined,
})

/**
 * The resolved context, as a discriminated union so a caller cannot read `orgId` without
 * having dealt with the cases where there is not one.
 *
 * `not-a-member` is the case the 6b shell's decision 9 is about, and it is why the org is
 * resolved here rather than by silently falling back: a link naming an org this account
 * cannot see must say nothing was switched. It cannot name the org either — the console
 * never had its name, and ADR-0057 answers an unknown and a non-member org identically.
 */
/**
 * The session shape and the role union, DERIVED from what `GET /internal/me` actually
 * returns rather than restated here.
 *
 * Restating them is what caught this: the first draft hand-wrote
 * `'admin' | 'engineer' | 'annotator'` and the typecheck refused it, because the schema has a
 * FOURTH role — `guest_expert`, the invited SME of PRODUCT.md 5.1. A hand-written union
 * would have compiled the day a fifth is added and silently mis-rendered it. This is the same
 * rule `queries.ts` states for response shapes: if it were annotated here, the annotation is
 * what would drift.
 */
export type MeData = NonNullable<Awaited<ReturnType<NonNullable<typeof meQuery.queryFn>>>>
export type Membership = MeData['memberships'][number]
export type OrgRole = Membership['role']

/*
 * What a role may do is NOT decided here. Every gate in the console reads `can(role, …)` from
 * `@labelloop/contracts` — the same map the API's `requirePermission` enforces (ADR-0068) — so
 * a screen can never offer what the server refuses. The map is deny-by-default: a role added
 * to the schema sees nothing until someone grants it something. A hidden item is still not
 * access control; the server's guard is.
 */

/** Everything the shell needs once an org has been settled on. */
export type ResolvedOrg = {
  orgId: string
  orgSlug: string
  orgName: string
  role: OrgRole
  email: string
  memberships: readonly Membership[]
}

export type ConsoleContext =
  | { state: 'pending' }
  | { state: 'signed-out' }
  | { state: 'failed'; error: unknown }
  /** Signed in, but a member of no org at all — where one is created (ADR-0063). */
  | { state: 'no-org'; email: string }
  /**
   * The URL named an org slug that is not one of this account's memberships.
   *
   * It carries the org the person is STILL in, because the shell renders AROUND this state
   * rather than replacing the page: surface 2's defining property is that the sidebar stays
   * usable (CONSOLE_FLOW §6), and "nothing has been switched" is a claim the console should
   * demonstrate by still showing that org, not merely assert in a sentence.
   */
  | { state: 'not-a-member'; fallback: ResolvedOrg }
  | ({ state: 'ready' } & ResolvedOrg)

/**
 * Resolve the active org from the URL and the bootstrap read.
 *
 * Note which role this reports: the role IN THE RESOLVED ORG, taken from the membership
 * list rather than from the response's top-level `role`. Those differ whenever the URL names
 * an org that is not the server's fallback, and a role is per-org (ADR-0014) — the same
 * account can be an admin in one and an annotator in the next, which is the whole reason the
 * shell renders differently for each.
 */
export const useConsoleContext = (): ConsoleContext => {
  const search = useSearch({ strict: false }) as ConsoleSearch
  const me = useQuery(meQuery)

  if (me.isPending) return { state: 'pending' }
  if (me.error !== null) return { state: 'failed', error: me.error }
  if (me.data === null) return { state: 'signed-out' }

  // A member of NO organisation arrives as data — an empty list — not as a refusal (ADR-0063).
  // Until then `/me` answered FORBIDDEN and this branched on the error code, which only worked
  // because `/me` had no other reason to refuse; it is the state that offers org creation.
  const { memberships, active_org_id, email } = me.data
  const fallback = memberships.find((m) => m.org_id === active_org_id) ?? memberships[0]
  if (fallback === undefined) return { state: 'no-org', email }

  const requested = search.org
  const active =
    requested === undefined ? fallback : memberships.find((m) => m.org_slug === requested)

  if (active === undefined) {
    // Deliberately reports the org the person is STILL in, not the one they asked for: the
    // message's job is "nothing has been switched", and the shell renders around it.
    return { state: 'not-a-member', fallback: resolved(fallback, email, memberships) }
  }

  return { state: 'ready', ...resolved(active, email, memberships) }
}

const resolved = (
  membership: Membership,
  email: string,
  memberships: readonly Membership[],
): ResolvedOrg => ({
  orgId: membership.org_id,
  orgSlug: membership.org_slug,
  orgName: membership.org_name,
  role: membership.role,
  email,
  memberships,
})

/**
 * The panel this view is about, or `null` at Home.
 *
 * Resolved from the SLUG in the path against the org's panel list, for the same reason the
 * org is: a slug is what a person can read in a URL, and the id is what the API takes. An
 * unknown slug is the same not-found state as an unknown org — a panel that does not exist
 * and one this account cannot see are not distinguished, which is ADR-0057's posture applied
 * to panels (Deviation 14 applies it the same way on the server).
 */
export type PanelContext =
  | { state: 'none' }
  | { state: 'pending' }
  | { state: 'failed'; error: unknown }
  | { state: 'not-found' }
  /** `traceCount` rides along because the sidebar's Review entry opens at the gate (M5 p5). */
  | { state: 'ready'; id: string; slug: string; name: string; traceCount: number }

export const usePanelContext = (orgId: string | null): PanelContext => {
  const params = useParams({ strict: false }) as { panelSlug?: string }
  const slug = params.panelSlug
  const panels = useQuery({
    ...panelsQuery(orgId ?? ''),
    enabled: orgId !== null && slug !== undefined,
  })

  if (slug === undefined || orgId === null) return { state: 'none' }
  if (panels.isPending) return { state: 'pending' }
  if (panels.error !== null) return { state: 'failed', error: panels.error }

  const panel = panels.data.find((p) => p.slug === slug)
  if (panel === undefined) return { state: 'not-found' }
  return {
    state: 'ready',
    id: panel.id,
    slug: panel.slug,
    name: panel.name,
    traceCount: panel.trace_count,
  }
}
