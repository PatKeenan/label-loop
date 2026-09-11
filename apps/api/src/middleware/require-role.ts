import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'
import type { OrgRole } from '../repositories/org-members.ts'

/**
 * Role enforcement for the console surface (ADR-0014, CONVENTIONS.md "Keys & auth":
 * *"Roles enforced in the API layer, never only in the UI"*).
 *
 * The schema has carried `org_members.role` since M0 and nothing read it; this is the file
 * that makes it mean something. It is deliberately tiny, and composes AFTER `sessionAuth()`
 * rather than replacing it: authentication and authorisation are separate questions, and a
 * guard that did both would have to be remembered in two places at every call site.
 *
 * **It reads the role for the ACTIVE org**, which is the only reason this ships in the same
 * phase as the org switcher. A role is per-org (ADR-0014), so a guard resolving against
 * "the first membership" enforces the wrong row the moment a second membership exists —
 * silently, and in the permissive direction if the first org is the one where you are an
 * admin. `sessionAuth` re-resolves the role per request against the org the request named,
 * so `c.var.session.role` is already the right row by the time this runs.
 */

/**
 * One message for every refusal, and it does not enumerate.
 *
 * "You need admin or engineer" tells a caller exactly which role to go phish for and, more
 * usefully to them, confirms that such a route exists and what guards it. The same sentence
 * for every role and every route is worth more than the debugging help, which nobody
 * legitimate needs: a person who cannot do something is told by the console, from the role
 * `/internal/me` already returned them.
 */
const FORBIDDEN = 'Your role in this organisation does not allow that.'

/**
 * Guards a route against a set of roles. Variadic rather than taking an array, so the call
 * site reads as the sentence it is: `requireRole('admin', 'engineer')`.
 */
export const requireRole = (...allowed: readonly OrgRole[]): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const { role } = c.var.session
    if (!allowed.includes(role)) {
      throw new AppError('FORBIDDEN', FORBIDDEN, {
        // Kept for the log line and the error tracker, never for the caller — `context` is
        // not serialized into the envelope, which is what lets it be specific.
        context: { reason: 'role is not permitted on this route', role, allowed },
      })
    }
    await next()
  }
}
