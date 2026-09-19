import { Hono } from 'hono'
import type { AppEnv } from '../../app-env.ts'
import { accountAuth, resolveActiveOrg } from '../../middleware/session.ts'
import { listMemberships } from '../../repositories/org-members.ts'
import { claimInvitations } from '../../services/members.ts'

/**
 * `GET /internal/me` — who the session belongs to, which org it is currently looking at,
 * and every org it could look at instead.
 *
 * It exists rather than the console reading better-auth's own session endpoint because the
 * answer the console needs is not the one better-auth has. better-auth knows the user;
 * membership and role live in OUR table (ADR-0014), and the org is what every other
 * internal route is scoped by. Returning both from one place means the console never has to
 * join two sources to answer "who am I and what am I looking at".
 *
 * `memberships` is what the org switcher renders (ADR-0047). It carries the org's NAME as
 * well as its id, because a switcher listing `org_01J…` is not a switcher — and because
 * `accountAuth` has already paid for that join, so the alternative is a second round trip
 * for data this response is holding.
 *
 * **`active_org_id` is named for what it is, and it is not a duplicate of the membership
 * that matches it.** It is the org this REQUEST resolved to — the one every other endpoint
 * filtered its rows by — and the client cannot derive it: when no `X-LabelLoop-Org` header
 * is sent, the server falls back to the first membership, and reproducing that would mean
 * the console reimplementing the ordering rule and trusting it matches. `role` beside it is
 * the role IN that org, which is why it is here rather than read off a membership: a role
 * is per-org (ADR-0014), so the same account can be `admin` in one and `annotator` in the
 * next. With one membership the two look redundant; with two they are the whole answer.
 */
export const createMeRoutes = () =>
  new Hono<AppEnv>().use('/me', accountAuth()).get('/me', async (c) => {
    const { userId, email } = c.var.account

    // THE CLAIM (ADR-0065). `/me` is the console's bootstrap read, so the first page load after
    // signing in is where a pending invitation becomes a membership — against the account's
    // VERIFIED email only; see `claimInvitations`. Memberships are re-read only when something
    // was claimed, so the common case costs one indexed lookup.
    const claimed = await claimInvitations({
      db: c.var.deps.db,
      clock: c.var.deps.clock,
      userId,
      requestId: c.var.requestId,
    })
    const memberships =
      claimed > 0 ? await listMemberships(c.var.deps.db, userId) : c.var.account.memberships

    // A MEMBER OF NOTHING IS AN ANSWER, not an error (ADR-0063). This route used to sit behind
    // `sessionAuth` and refuse them with FORBIDDEN, which left the console guessing what a 403
    // from its bootstrap read meant. It is the state where the console offers to create an
    // organisation, so it is data: no active org, no role, and an empty list.
    if (memberships.length === 0) {
      return c.json({
        data: {
          user_id: userId,
          email,
          active_org_id: null,
          role: null,
          memberships: [],
        },
        request_id: c.var.requestId,
      })
    }

    // Otherwise exactly what `sessionAuth` would resolve — including NOT_FOUND for an org
    // header this account cannot see (ADR-0057).
    const active = resolveActiveOrg(c, memberships)
    return c.json({
      data: {
        user_id: userId,
        email,
        active_org_id: active.orgId as string | null,
        role: active.role as (typeof active)['role'] | null,
        memberships: memberships.map((membership) => ({
          org_id: membership.orgId,
          org_name: membership.orgName,
          org_slug: membership.orgSlug,
          role: membership.role,
        })),
      },
      request_id: c.var.requestId,
    })
  })
