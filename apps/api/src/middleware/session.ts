import type { MiddlewareHandler } from 'hono'
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
 * The header the console names its active org with (ADR-0047).
 *
 * Exported because three places must agree on the spelling and only one of them can be
 * wrong silently: this middleware reads it, `routes/internal/index.ts` must allow it through
 * CORS preflight, and the tests assert on it. A custom request header is not on the CORS
 * safelist, so a header allowed here and forgotten there fails only in a real browser —
 * never in a test, which sends no preflight.
 */
export const ACTIVE_ORG_HEADER = 'X-LabelLoop-Org'

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
 * are — and telling them plainly is what makes the state fixable rather than mysterious.
 */
const NOT_A_MEMBER = 'This account is not a member of any organisation. Ask an owner to invite you.'

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

export const sessionAuth = (): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
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

    c.set('session', {
      userId: session.user.id,
      email: session.user.email,
      orgId: active.orgId,
      role: active.role,
      memberships,
    })
    // The ids, never the email: a log stream is not an access-controlled store, and an
    // address is the one field here that identifies a person outside this system.
    c.var.logger.assign({ user_id: session.user.id, org_id: active.orgId })
    await next()
  }
}
