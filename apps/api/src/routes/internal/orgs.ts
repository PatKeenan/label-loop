import { displayNameSchema, slugSchema } from '@labelloop/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { accountAuth } from '../../middleware/session.ts'
import { createOrg } from '../../services/create-org.ts'

/**
 * `POST /internal/orgs` — an account that belongs to no organisation creates one, and becomes
 * its admin (ADR-0063).
 *
 * Behind `accountAuth`, not `sessionAuth`, because its caller by definition has no org for
 * `sessionAuth` to resolve. That makes it one of only two routes that serve a session with no
 * tenant (`/me` is the other), and the reason this file is small.
 *
 * **Only a member of NOTHING may call it, at M4.** Creating a second org from the switcher is a
 * different feature with different questions (who may, and does it need an invite model first),
 * and M8's Organisation settings is where those get answered. The console never offers this to
 * a member of anything; the refusal below is the server guard that offer mirrors.
 *
 * **Unmetered until M8.** Any account that can sign in can create one organisation, and the
 * sign-in door in production is GitHub (ADR-0049). Quotas arrive with billing
 * (`docs/PARKING_LOT.md`).
 */

/**
 * The shared rules (`@labelloop/contracts` `names.ts`), which the console renders as a live
 * checklist. The slug appears in the console's URL as `?org=` and is globally unique.
 */
const createBodySchema = z.object({
  slug: slugSchema,
  name: displayNameSchema,
})

export const createOrgRoutes = () =>
  new Hono<AppEnv>().use('/orgs', accountAuth()).post('/orgs', async (c) => {
    const { db, clock } = c.var.deps
    const { userId, memberships } = c.var.account

    if (memberships.length > 0) {
      throw new AppError(
        'FORBIDDEN',
        'An organisation can only be created by an account that belongs to none.',
        { context: { reason: 'org creation attempted by an existing member' } },
      )
    }

    const body = createBodySchema.safeParse(await c.req.json().catch(() => undefined))
    if (!body.success) {
      throw new AppError('VALIDATION_ERROR', 'The request body failed validation.', {
        issues: body.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      })
    }

    const result = await createOrg({
      db,
      clock,
      userId,
      requestId: c.var.requestId,
      org: body.data,
    })
    if (!result.ok) {
      // Slugs are GLOBAL, so this does confirm an org with that slug exists. That is the same
      // disclosure any "username taken" makes, and a slug is not an id: it opens nothing.
      throw new AppError('VALIDATION_ERROR', 'That organisation slug is already taken.', {
        issues: [{ path: 'slug', message: 'That slug is taken — choose another.' }],
      })
    }

    return c.json(
      {
        data: {
          org_id: result.orgId,
          slug: result.slug,
          name: result.name,
          role: 'admin' as const,
        },
        request_id: c.var.requestId,
      },
      201,
    )
  })
