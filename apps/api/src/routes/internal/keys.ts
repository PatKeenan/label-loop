import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requireRole } from '../../middleware/require-role.ts'
import { listApiKeys } from '../../repositories/api-keys.ts'
import { panelBelongsToOrg } from '../../repositories/panels.ts'
import { issueApiKey, revokeApiKey } from '../../services/api-keys.ts'

/**
 * `/internal/keys` — issuing, listing and revoking the credentials a customer's agent calls
 * `/v1` with.
 *
 * **Every route here is org-scoped from the SESSION and never from the request.** The org is
 * not a parameter any caller can supply; `panel_id` is the only tenant-owned id that arrives
 * in a body, and it is checked against the session's org before it reaches the service. That
 * check is the one tenancy hole this surface actually has — a key scoped to somebody else's
 * panel would authenticate against their traffic.
 *
 * Guarded by `requireRole('admin', 'engineer')`, applied HERE rather than in `index.ts`, so
 * the guard travels with the routes it guards. An annotator has a legitimate session and must
 * not be able to mint a credential with it (CONVENTIONS.md: *"Roles enforced in the API
 * layer, never only in the UI"*).
 */

/** Long enough to distinguish two clients, short enough not to be a description. */
const MAX_NAME_LENGTH = 80

const createBodySchema = z.object({
  panel_id: z.string().min(1),
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
})

/**
 * The refusal for a panel that is not this org's — and for one that does not exist. The same
 * answer for both, deliberately, exactly as `sessionAuth` treats orgs (ADR-0057).
 */
const NO_SUCH_PANEL = 'No panel with that id is available to this organisation.'

/** The same again for keys: not yours, gone, or already revoked are one answer. */
const NO_SUCH_KEY = 'No active key with that id is available to this organisation.'

const validationError = (issues: z.ZodIssue[]): AppError =>
  new AppError('VALIDATION_ERROR', 'The request body failed validation.', {
    issues: issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  })

export const createKeyRoutes = () =>
  new Hono<AppEnv>()
    .use('/keys', requireRole('admin', 'engineer'))
    .use('/keys/*', requireRole('admin', 'engineer'))
    .post('/keys', async (c) => {
      const { db, clock, config } = c.var.deps
      const { orgId, userId } = c.var.session

      const body = createBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!body.success) throw validationError(body.error.issues)

      // Before anything is minted: a panel the session's org does not own is not a panel
      // this caller can scope a credential to.
      if (!(await panelBelongsToOrg(db, body.data.panel_id, orgId))) {
        throw new AppError('NOT_FOUND', NO_SUCH_PANEL, {
          context: { reason: 'panel is not owned by the session org' },
        })
      }

      const issued = await issueApiKey({
        db,
        clock,
        nodeEnv: config.NODE_ENV,
        orgId,
        panelId: body.data.panel_id,
        name: body.data.name,
        actorId: userId,
        requestId: c.var.requestId,
      })

      return c.json(
        {
          data: {
            id: issued.id,
            last4: issued.last4,
            // The one and only time this crosses the wire. It is not stored and cannot be
            // recovered, which the flag says out loud so a client has no excuse to expect
            // it from the list endpoint.
            key: issued.plaintext,
            shown_once: true,
          },
          request_id: c.var.requestId,
        },
        201,
      )
    })
    .get('/keys', async (c) => {
      const keys = await listApiKeys(c.var.deps.db, c.var.session.orgId)
      return c.json({
        data: {
          keys: keys.map((key) => ({
            id: key.id,
            panel_id: key.panelId,
            name: key.name,
            last4: key.last4,
            status: key.status,
            revoked_at: key.revokedAt?.toISOString() ?? null,
            created_at: key.createdAt.toISOString(),
          })),
        },
        request_id: c.var.requestId,
      })
    })
    .post('/keys/:key_id/revoke', async (c) => {
      const { db, clock } = c.var.deps
      const { orgId, userId } = c.var.session

      const revoked = await revokeApiKey({
        db,
        clock,
        orgId,
        keyId: c.req.param('key_id'),
        actorId: userId,
        requestId: c.var.requestId,
      })

      // Not yours, never existed, or already revoked — one answer for all three. Telling
      // them apart would confirm another tenant's key id exists.
      if (!revoked) {
        throw new AppError('NOT_FOUND', NO_SUCH_KEY, {
          context: { reason: 'key is not this org’s, does not exist, or was already revoked' },
        })
      }

      return c.json({
        data: { id: c.req.param('key_id'), status: 'revoked' },
        request_id: c.var.requestId,
      })
    })
