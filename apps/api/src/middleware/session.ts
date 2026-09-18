import { ACTIVE_ORG_HEADER } from '@labelloop/contracts'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'
import { listMemberships, type Membership, type OrgRole } from '../repositories/org-members.ts'

/**
 * Session authentication for the console surface (ADR-0008, CONVENTIONS.md "Keys & auth").
 *
 * **The two auth paths never cross, and this file is one half of the proof.** It reads a
 * better-auth session cookie and nothing else, so an `Authorization: Bearer llk_…` presented
 * here produces no session and is turned away — not by a rule that remembers to reject API
 * keys, but because nothing in this path ever looks at that header. `api-key-auth.ts` is the
 * mirror image: it reads the bearer token and never a cookie, so a console session gets
 * nowhere near `/v1`. Both directions are asserted in `session.test.ts`.
 *
 * It resolves ORG MEMBERSHIP as well as identity, and that is deliberate rather than
 * convenient. Every internal route is tenant-scoped, and the classic way a console leaks
 * across tenants is a handler that authenticates and then forgets to filter. Resolving the
 * org here means a route cannot read a row without saying whose org it belongs to, because
 * the org is the only thing it has to filter by.
 *
 * **M4 removed the safety net that made the paragraph above automatically true.** Until the
 * switcher existed there was exactly one org a request could possibly mean, so "forgot to
 * filter" could not select the wrong tenant — only the right one. Now the caller names the
 * org (ADR-0047), which means this file is the single place that decides whether they are
 * allowed to. Everything downstream still reads `session.orgId` and stays org-implicit; the
 * org becomes explicit once, here, at the boundary.
 */

/**
 * Re-exported so this middleware's existing readers keep one import, but OWNED by
 * `@labelloop/contracts` since M4 phase 7 — the console has to send this header and cannot
 * import from here, because this module pulls better-auth and a database pool with it.
 * The comment explaining why the spelling matters travels with the definition.
 */
export { ACTIVE_ORG_HEADER }

/**
 * What `accountAuth` establishes: a real, signed-in person and their memberships — which may
 * be empty. Only the routes a member of nothing must reach see this shape (ADR-0063).
 */
export type AuthenticatedAccount = {
  userId: string
  email: string
  memberships: readonly Membership[]
}

/** What an internal route may assume once this middleware has run. */
export type AuthenticatedSession = {
  userId: string
  email: string
  /** The ACTIVE org: the one this request named, or the first membership if it named none. */
  orgId: string
  /**
   * The role IN the active org, not a property of the person (ADR-0014). It is re-resolved
   * per request for that reason — the same account can be an admin in one org and an
   * annotator in another, so a role cached against the user would be wrong half the time.
   */
  role: OrgRole
  /**
   * Every org this account belongs to, so the console renders its switcher from the reply
   * it already has rather than a second round trip.
   */
  memberships: readonly Membership[]
}

/**
 * One message for every failure, for the same reason the API-key path has one: naming which
 * check failed tells an unauthenticated caller whether an account exists.
 */
const UNAUTHENTICATED = 'Sign in to use the console.'

/**
 * A member of no organisation is a different answer from an unknown visitor, and it gets a
 * different code. There is no secret to keep here — the caller has already proved who they
 * are. Since ADR-0063 the console never shows this: it reads membership from `/me`, which
 * answers a member of nothing with an empty list, and offers to create an organisation. This
 * is what every OTHER route says to them, which only a direct API call now reaches.
 */
const NOT_A_MEMBER =
  'This account is not a member of any organisation. Create one from the console, or ask an admin to add you.'

/**
 * The refusal for a requested org that is not one of yours — and for one that does not
 * exist. **The same sentence and the same code for both, deliberately** (ADR-0057).
 *
 * `FORBIDDEN` would be the instinctive choice and it is the wrong one: it confirms the org
 * exists and says only that this account cannot reach it, which turns the header into an
 * org-id oracle. `api-key-auth.ts` already takes this posture for a key scoped to another
 * panel, and both auth paths now refuse the same way.
 *
 * The cost is real and was accepted rather than overlooked: a member of another org who
 * follows a stale link gets a message that cannot tell them so.
 */
const NO_SUCH_ORG = 'No organisation with that id is available to this account.'

/**
 * Who is signed in — the half of `sessionAuth` that does not need an org. Throws
 * `UNAUTHORIZED` for no session, exactly as `sessionAuth` does.
 */
const authenticate = async (c: Context<AppEnv>): Promise<AuthenticatedAccount> => {
  const { auth, db } = c.var.deps

  // better-auth is handed the raw headers rather than a parsed cookie: cookie names,
  // signing and expiry are its concern, and reimplementing any of that here would be a
  // second, worse implementation of the thing we chose a library for.
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (session === null) {
    throw new AppError('UNAUTHORIZED', UNAUTHENTICATED, {
      context: { reason: 'no valid session cookie' },
    })
  }
  const memberships = await listMemberships(db, session.user.id)
  return { userId: session.user.id, email: session.user.email, memberships }
}

/**
 * Which org this request is about, from `X-LabelLoop-Org` or the first membership. Exported
 * for `/me`, the one route that resolves it only AFTER confirming there is anything to
 * resolve — every other route gets it through `sessionAuth`.
 *
 * `NOT_FOUND` for an org that is not one of yours, and for one that does not exist (ADR-0057).
 */
export const resolveActiveOrg = (
  c: Context<AppEnv>,
  memberships: readonly Membership[],
): Membership => {
  const first = memberships[0]
  if (first === undefined) {
    throw new AppError('FORBIDDEN', NOT_A_MEMBER, {
      context: { reason: 'authenticated, but a member of no org' },
    })
  }

  // Trimmed, and empty treated as absent: a client that sets the header from an unset
  // variable sends `""`, and answering NOT_FOUND to that would be a confusing way to say
  // "you sent nothing".
  const requested = c.req.header(ACTIVE_ORG_HEADER)?.trim()
  const active =
    requested === undefined || requested === ''
      ? first
      : memberships.find((membership) => membership.orgId === requested)

  if (active === undefined) {
    // The id is kept for the log line and the error tracker, never for the caller —
    // `AppError.context` is not serialized into the envelope.
    throw new AppError('NOT_FOUND', NO_SUCH_ORG, {
      context: { reason: 'requested org is not one of this account’s memberships' },
    })
  }
  return active
}

/**
 * Identity only — for the two routes a member of NO organisation must still reach (ADR-0063).
 *
 * It is the first half of `sessionAuth` and nothing else: the same cookie, the same single
 * `UNAUTHORIZED`, and no org. Guarding a route with it is a claim that the route is safe to
 * serve with no tenant, so the list of routes behind it should stay very short.
 */
export const accountAuth = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const account = await authenticate(c)
    c.set('account', account)
    c.var.logger.assign({ user_id: account.userId })
    await next()
  }
}

export const sessionAuth = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const { userId, email, memberships } = await authenticate(c)
    const active = resolveActiveOrg(c, memberships)

    c.set('session', {
      userId,
      email,
      orgId: active.orgId,
      role: active.role,
      memberships,
    })
    // The ids, never the email: a log stream is not an access-controlled store, and an
    // address is the one field here that identifies a person outside this system.
    c.var.logger.assign({ user_id: userId, org_id: active.orgId })
    await next()
  }
}
