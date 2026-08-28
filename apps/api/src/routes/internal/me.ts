import { Hono } from 'hono'
import type { AppEnv } from '../../app-env.ts'

/**
 * `GET /internal/me` — who the session belongs to, and which org it may see.
 *
 * It exists rather than the console reading better-auth's own session endpoint because the
 * answer the console needs is not the one better-auth has. better-auth knows the user;
 * membership and role live in OUR table (ADR-0014), and the org is what every other
 * internal route is scoped by. Returning both from one place means the console never has to
 * join two sources to answer "who am I and what am I looking at".
 */
export const createMeRoutes = () =>
  new Hono<AppEnv>().get('/me', (c) => {
    const { userId, email, orgId, role } = c.var.session
    return c.json({
      data: { user_id: userId, email, org_id: orgId, role },
      request_id: c.var.requestId,
    })
  })
