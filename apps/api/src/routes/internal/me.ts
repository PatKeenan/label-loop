import { Hono } from 'hono'
import type { AppEnv } from '../../app-env.ts'

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
 * `sessionAuth` has already paid for that join, so the alternative is a second round trip
 * for data this response is holding.
 */
export const createMeRoutes = () =>
  new Hono<AppEnv>().get('/me', (c) => {
    const { userId, email, orgId, role, memberships } = c.var.session
    return c.json({
      data: {
        user_id: userId,
        email,
        org_id: orgId,
        role,
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
