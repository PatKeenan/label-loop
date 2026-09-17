import { useQuery } from '@tanstack/react-query'
import { useParams, useSearch } from '@tanstack/react-router'
import { meQuery, panelsQuery } from '../../api/queries.ts'
import { ApiError } from '../../errors/api-error.ts'

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
export type ConsoleSearch = { org?: string }

export const validateConsoleSearch = ({ org }: Record<string, unknown>): ConsoleSearch =>
  // An empty `?org=` is treated as absent rather than as a slug nothing matches, so a client
  // that builds the URL from an unset value lands on the default org instead of on a
  // not-found state that blames the person for a bug in a link.
  typeof org === 'string' && org !== '' ? { org } : {}

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

/**
 * Whether a role gets the console at all.
 *
 * Written as an ALLOW list, not as `!== 'annotator'`. A new role added to the schema must
 * default to seeing nothing until someone decides otherwise — the opposite default would
 * hand a console to whoever is added next, which is not a decision anyone would have made on
 * purpose. It mirrors the server rather than replacing it: `requireRole` is the guard, and a
 * hidden nav item is not access control.
 */
export const isStaffRole = (role: OrgRole): boolean => role === 'admin' || role === 'engineer'

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
  /** Signed in, but a member of no org at all — CONSOLE_FLOW Q4. */
  | { state: 'no-org' }
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
  // A member of no org is refused by `sessionAuth` itself, before any handler runs, so it
  // arrives here as a FORBIDDEN rather than as an empty membership list.
  if (me.error !== null) {
    // `sessionAuth` refuses an account that belongs to no org before any handler runs
    // (`FORBIDDEN` / NOT_A_MEMBER), so "member of nothing" arrives as a failure rather than
    // as an empty membership list. It is a STATE the shell draws, not an error — see
    // CONSOLE_FLOW Q4, accepted for M4 with no way forward because none exists yet.
    const isNoOrg = me.error instanceof ApiError && me.error.code === 'FORBIDDEN'
    return isNoOrg ? { state: 'no-org' } : { state: 'failed', error: me.error }
  }
  if (me.data === null) return { state: 'signed-out' }

  const { memberships, active_org_id, email } = me.data
  const fallback = memberships.find((m) => m.org_id === active_org_id) ?? memberships[0]
  if (fallback === undefined) return { state: 'no-org' }

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
  | { state: 'ready'; id: string; slug: string; name: string }

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
  return { state: 'ready', id: panel.id, slug: panel.slug, name: panel.name }
}
