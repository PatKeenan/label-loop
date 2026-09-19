import { can, type PermissionRequest } from '@labelloop/contracts'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'

/**
 * Capability enforcement for the console surface (ADR-0064, ADR-0068; CONVENTIONS.md "Keys &
 * auth": *"Roles enforced in the API layer, never only in the UI"*).
 *
 * A route asks for what it DOES — `requirePermission({ key: ['issue'] })` — and the shared map
 * in `@labelloop/contracts` says which roles may do it. It replaced `requireRole`, whose role
 * lists made "may a developer annotate?" a question every call site had to answer again; now
 * it is answered once, in the map, and the console reads the same map.
 *
 * It composes AFTER `sessionAuth()` rather than replacing it: authentication and
 * authorisation are separate questions. **It reads the role for the ACTIVE org** — a role is
 * per-org (ADR-0014), and `sessionAuth` re-resolves it per request against the org the request
 * named, so `c.var.session.role` is already the right row by the time this runs.
 */

/**
 * One message for every refusal, and it does not enumerate.
 *
 * "You need to be able to issue keys" tells a caller which role to go phish for and confirms
 * what a route guards. The same sentence for every role and every route is worth more than
 * the debugging help, which nobody legitimate needs: the console already knows the caller's
 * role from `/internal/me` and reads the same capability map.
 */
const FORBIDDEN = 'Your role in this organisation does not allow that.'

export const requirePermission = (request: PermissionRequest): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const { role } = c.var.session
    if (!can(role, request)) {
      throw new AppError('FORBIDDEN', FORBIDDEN, {
        // Kept for the log line and the error tracker, never for the caller — `context` is
        // not serialized into the envelope, which is what lets it be specific.
        context: { reason: 'role lacks the capability this route needs', role, request },
      })
    }
    await next()
  }
}
