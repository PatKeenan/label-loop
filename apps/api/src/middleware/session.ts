import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'
import { findMembership, type OrgRole } from '../repositories/org-members.ts'

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
 */

/** What an internal route may assume once this middleware has run. */
export type AuthenticatedSession = {
  userId: string
  email: string
  /** The org whose data this request may see. There is exactly one at M0. */
  orgId: string
  /** Present from M0, ENFORCED from M4 (ADR-0014). Carried so the console can render it. */
  role: OrgRole
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

    const membership = await findMembership(db, session.user.id)
    if (membership === undefined) {
      throw new AppError('FORBIDDEN', NOT_A_MEMBER, {
        context: { reason: 'authenticated, but a member of no org' },
      })
    }

    c.set('session', {
      userId: session.user.id,
      email: session.user.email,
      orgId: membership.orgId,
      role: membership.role,
    })
    // The ids, never the email: a log stream is not an access-controlled store, and an
    // address is the one field here that identifies a person outside this system.
    c.var.logger.assign({ user_id: session.user.id, org_id: membership.orgId })
    await next()
  }
}
