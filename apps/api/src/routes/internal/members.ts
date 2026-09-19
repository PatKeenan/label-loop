import { grantableRoleSchema, invitationEmailSchema } from '@labelloop/contracts'
import { Hono, type MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import {
  changeRole,
  invite,
  listMembers,
  type MemberChangeResult,
  removeMember,
  revokeInvitation,
} from '../../services/members.ts'

/**
 * Organisation settings → Members (ADR-0065, ADR-0070): who is in the org, with what role, and
 * who has been invited. Reading is `member: [read]`; every write is `member: [manage]`, which
 * only an admin holds.
 *
 * Org-scoped from the SESSION, never from the request. Another org's member or invitation is
 * NOT_FOUND — the same answer as one that does not exist (ADR-0057).
 */

const inviteBodySchema = z.object({ email: invitationEmailSchema, role: grantableRoleSchema })
const roleBodySchema = z.object({ role: grantableRoleSchema })

const NO_SUCH_MEMBER = 'No member with that id is in this organisation.'
const NO_SUCH_INVITATION = 'No open invitation with that id is in this organisation.'

/** Reported on the field, because it is a fact about the choice rather than about the request. */
const LAST_ADMIN = 'An organisation must keep at least one admin. Make someone else an admin first.'

/**
 * Hono's own `validator` rather than a hand-parse, so the body's TYPE reaches the console over
 * RPC — `hc<AppType>` cannot see a body a handler parses itself. A malformed body is the same
 * 422 with field issues as everywhere else.
 */
const jsonBody = <T>(schema: z.ZodType<T>) =>
  validator('json', (value): T => {
    const body = schema.safeParse(value)
    if (body.success) return body.data
    throw new AppError('VALIDATION_ERROR', 'The request body failed validation.', {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    })
  })

/**
 * Runs BEFORE `jsonBody`: Hono's validator answers a body that is not JSON with its own 400,
 * which the central handler cannot place in the taxonomy and reports as INTERNAL. Parsing once
 * here makes it the same 422 a hand-parsed route gives; Hono caches the body, so the validator
 * does not read it twice.
 */
const wellFormedJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parsed = await c.req.json().then(
    () => true,
    () => false,
  )
  if (!parsed) {
    throw new AppError('VALIDATION_ERROR', 'The request body must be JSON.', {
      issues: [{ path: '', message: 'The request body must be JSON.' }],
    })
  }
  await next()
}

const refuseChange = (result: Exclude<MemberChangeResult, { ok: true }>, field: string): never => {
  if (result.kind === 'not_found') {
    throw new AppError('NOT_FOUND', NO_SUCH_MEMBER, {
      context: { reason: 'member is not in the active org' },
    })
  }
  throw new AppError('VALIDATION_ERROR', LAST_ADMIN, {
    issues: [{ path: field, message: LAST_ADMIN }],
  })
}

export const createMemberRoutes = () =>
  new Hono<AppEnv>()
    .get('/members', requirePermission({ member: ['read'] }), async (c) => {
      const { orgId } = c.var.session
      const { members, invitations } = await listMembers(c.var.deps.db, {
        orgId,
        now: new Date(c.var.deps.clock.now()),
      })
      return c.json({
        data: {
          members: members.map((member) => ({
            user_id: member.userId,
            email: member.email,
            name: member.name,
            role: member.role,
            joined_at: member.joinedAt.toISOString(),
          })),
          invitations: invitations.map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            invited_by_email: invitation.invitedByEmail,
            created_at: invitation.createdAt.toISOString(),
            expires_at: invitation.expiresAt.toISOString(),
          })),
        },
        request_id: c.var.requestId,
      })
    })
    .post(
      '/invitations',
      requirePermission({ member: ['manage'] }),
      wellFormedJson,
      jsonBody(inviteBodySchema),
      async (c) => {
        const body = c.req.valid('json')
        const result = await invite({
          db: c.var.deps.db,
          clock: c.var.deps.clock,
          orgId: c.var.session.orgId,
          actorId: c.var.session.userId,
          requestId: c.var.requestId,
          email: body.email,
          role: body.role,
        })
        if (!result.ok) {
          const message =
            result.kind === 'already_member'
              ? 'That person is already a member of this organisation.'
              : 'That email already has an invitation waiting. Revoke it to change the role.'
          throw new AppError('VALIDATION_ERROR', message, { issues: [{ path: 'email', message }] })
        }
        return c.json(
          {
            data: {
              id: result.invitationId,
              email: body.email,
              role: body.role,
              expires_at: result.expiresAt.toISOString(),
            },
            request_id: c.var.requestId,
          },
          201,
        )
      },
    )
    .delete('/invitations/:id', requirePermission({ member: ['manage'] }), async (c) => {
      const revoked = await revokeInvitation({
        db: c.var.deps.db,
        clock: c.var.deps.clock,
        orgId: c.var.session.orgId,
        actorId: c.var.session.userId,
        requestId: c.var.requestId,
        invitationId: c.req.param('id'),
      })
      if (!revoked) {
        throw new AppError('NOT_FOUND', NO_SUCH_INVITATION, {
          context: { reason: 'invitation is not open in the active org' },
        })
      }
      return c.json({ data: { id: c.req.param('id'), revoked: true }, request_id: c.var.requestId })
    })
    .patch(
      '/members/:userId',
      requirePermission({ member: ['manage'] }),
      wellFormedJson,
      jsonBody(roleBodySchema),
      async (c) => {
        const body = c.req.valid('json')
        const result = await changeRole({
          db: c.var.deps.db,
          clock: c.var.deps.clock,
          orgId: c.var.session.orgId,
          actorId: c.var.session.userId,
          requestId: c.var.requestId,
          userId: c.req.param('userId'),
          role: body.role,
        })
        if (!result.ok) refuseChange(result, 'role')
        return c.json({
          data: { user_id: c.req.param('userId'), role: body.role },
          request_id: c.var.requestId,
        })
      },
    )
    .delete('/members/:userId', requirePermission({ member: ['manage'] }), async (c) => {
      const result = await removeMember({
        db: c.var.deps.db,
        clock: c.var.deps.clock,
        orgId: c.var.session.orgId,
        actorId: c.var.session.userId,
        requestId: c.var.requestId,
        userId: c.req.param('userId'),
      })
      if (!result.ok) refuseChange(result, 'user_id')
      return c.json({
        data: { user_id: c.req.param('userId'), removed: true },
        request_id: c.var.requestId,
      })
    })
