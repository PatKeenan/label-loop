import { type GrantableRole, INVITATION_TTL_DAYS, newId, type OrgRole } from '@labelloop/contracts'
import { type Database, schema } from '@labelloop/db'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import type { Clock } from '../ports/clock.ts'
import { recordAuditEvent } from '../repositories/audit-events.ts'
import type { Executor } from '../repositories/executor.ts'

/**
 * Who is in an organisation, and how they got there (ADR-0065, ADR-0070).
 *
 * **Every write is one transaction with its audit event** (ADR-0051): a membership nobody
 * recorded granting is access with no provenance. The events carry ids and roles, never an
 * email — the audit log cannot be edited, and a person's address is exactly what erasure
 * (M8) must be able to scrub. The invitation row holds the email; the event points at it.
 *
 * **An org always keeps one admin.** Demoting or removing the last is refused, under a row
 * lock on the org's admins, so two admins demoting each other at the same moment cannot both
 * succeed and leave nobody able to manage the org.
 */

const DAY_MS = 24 * 60 * 60 * 1000

// ── Reads ─────────────────────────────────────────────────────────────────────────────────

export type MemberRow = {
  userId: string
  email: string
  name: string
  role: OrgRole
  joinedAt: Date
}

export type InvitationRow = {
  id: string
  email: string
  role: OrgRole
  invitedByEmail: string
  createdAt: Date
  expiresAt: Date
}

/** Members, oldest first, and invitations still waiting — open and unexpired. */
export const listMembers = async (
  db: Database,
  { orgId, now }: { orgId: string; now: Date },
): Promise<{ members: MemberRow[]; invitations: InvitationRow[] }> => {
  const members = await db
    .select({
      userId: schema.orgMembers.userId,
      email: schema.user.email,
      name: schema.user.name,
      role: schema.orgMembers.role,
      joinedAt: schema.orgMembers.createdAt,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.orgMembers.userId))
    .where(eq(schema.orgMembers.orgId, orgId))
    .orderBy(asc(schema.orgMembers.createdAt))

  const invitations = await db
    .select({
      id: schema.orgInvitations.id,
      email: schema.orgInvitations.email,
      role: schema.orgInvitations.role,
      invitedByEmail: schema.user.email,
      createdAt: schema.orgInvitations.createdAt,
      expiresAt: schema.orgInvitations.expiresAt,
    })
    .from(schema.orgInvitations)
    .innerJoin(schema.user, eq(schema.user.id, schema.orgInvitations.invitedBy))
    .where(
      and(
        eq(schema.orgInvitations.orgId, orgId),
        isOpen(),
        gt(schema.orgInvitations.expiresAt, now),
      ),
    )
    .orderBy(asc(schema.orgInvitations.createdAt))

  return { members, invitations }
}

const isOpen = () =>
  and(isNull(schema.orgInvitations.acceptedAt), isNull(schema.orgInvitations.revokedAt))

// ── Invite ────────────────────────────────────────────────────────────────────────────────

type Actor = { db: Database; clock: Clock; orgId: string; actorId: string; requestId: string }

export type InviteResult =
  | { ok: true; invitationId: string; expiresAt: Date }
  | { ok: false; kind: 'already_member' | 'already_invited' }

export const invite = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  email,
  role,
}: Actor & { email: string; role: GrantableRole }): Promise<InviteResult> => {
  const now = new Date(clock.now())
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS)
  const invitationId = newId('inv_')

  return db.transaction(async (tx) => {
    const [member] = await tx
      .select({ userId: schema.orgMembers.userId })
      .from(schema.orgMembers)
      .innerJoin(schema.user, eq(schema.user.id, schema.orgMembers.userId))
      .where(and(eq(schema.orgMembers.orgId, orgId), eq(sql`lower(${schema.user.email})`, email)))
      .limit(1)
    if (member !== undefined) return { ok: false, kind: 'already_member' } as const

    const [open] = await tx
      .select({ id: schema.orgInvitations.id, expiresAt: schema.orgInvitations.expiresAt })
      .from(schema.orgInvitations)
      .where(
        and(
          eq(schema.orgInvitations.orgId, orgId),
          eq(schema.orgInvitations.email, email),
          isOpen(),
        ),
      )
      .for('update')
    if (open !== undefined) {
      if (open.expiresAt > now) return { ok: false, kind: 'already_invited' } as const
      // An EXPIRED invitation still holds the one-open-per-email index (expiry cannot be in a
      // partial index's predicate), so inviting again closes it first. It is closed as revoked:
      // superseded is what happened to it, and it can no longer be claimed either way.
      await tx
        .update(schema.orgInvitations)
        .set({ revokedAt: now, updatedAt: now })
        .where(eq(schema.orgInvitations.id, open.id))
    }

    await tx.insert(schema.orgInvitations).values({
      id: invitationId,
      orgId,
      email,
      role,
      invitedBy: actorId,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    })
    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'invitation.created',
      subjectType: 'invitation',
      subjectId: invitationId,
      data: { role, expires_at: expiresAt.toISOString() },
      requestId,
    })
    return { ok: true, invitationId, expiresAt } as const
  })
}

// ── Revoke an invitation ──────────────────────────────────────────────────────────────────

/** `false` for an invitation that is not this org's, not open, or does not exist — one answer. */
export const revokeInvitation = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  invitationId,
}: Actor & { invitationId: string }): Promise<boolean> => {
  const now = new Date(clock.now())
  return db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(schema.orgInvitations)
      .set({ revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.orgInvitations.id, invitationId),
          eq(schema.orgInvitations.orgId, orgId),
          isOpen(),
        ),
      )
      .returning({ role: schema.orgInvitations.role })
    if (revoked === undefined) return false

    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'invitation.revoked',
      subjectType: 'invitation',
      subjectId: invitationId,
      data: { role: revoked.role },
      requestId,
    })
    return true
  })
}

// ── Change a role, remove a member ────────────────────────────────────────────────────────

export type MemberChangeResult = { ok: true } | { ok: false; kind: 'not_found' | 'last_admin' }

/**
 * The org's admins, LOCKED for the rest of the transaction. Every change that could leave an
 * org without an admin takes this lock first, so two such changes serialise and the second
 * sees the first's result.
 */
const lockAdmins = async (tx: Executor, orgId: string): Promise<string[]> => {
  const rows = await tx
    .select({ userId: schema.orgMembers.userId })
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.role, 'admin')))
    .for('update')
  return rows.map((row) => row.userId)
}

const findRole = async (tx: Executor, orgId: string, userId: string) => {
  const [row] = await tx
    .select({ role: schema.orgMembers.role })
    .from(schema.orgMembers)
    .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId)))
    .for('update')
  return row?.role
}

export const changeRole = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  userId,
  role,
}: Actor & { userId: string; role: GrantableRole }): Promise<MemberChangeResult> => {
  const now = new Date(clock.now())
  return db.transaction(async (tx) => {
    const admins = await lockAdmins(tx, orgId)
    const from = await findRole(tx, orgId, userId)
    if (from === undefined) return { ok: false, kind: 'not_found' } as const
    // Not a change, so not an event: the audit log records what happened, and nothing did.
    if (from === role) return { ok: true } as const
    if (from === 'admin' && admins.length <= 1) return { ok: false, kind: 'last_admin' } as const

    await tx
      .update(schema.orgMembers)
      .set({ role, updatedAt: now })
      .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId)))
    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'member.role_changed',
      subjectType: 'user',
      subjectId: userId,
      data: { from, to: role },
      requestId,
    })
    return { ok: true } as const
  })
}

/**
 * Removing a member deletes the MEMBERSHIP only. Everything they authored or annotated points
 * at `user` with RESTRICT (`authored.ts`, ADR-0069), so their work stays attributed to them.
 */
export const removeMember = async ({
  db,
  orgId,
  actorId,
  requestId,
  userId,
}: Actor & { userId: string }): Promise<MemberChangeResult> => {
  return db.transaction(async (tx) => {
    const admins = await lockAdmins(tx, orgId)
    const role = await findRole(tx, orgId, userId)
    if (role === undefined) return { ok: false, kind: 'not_found' } as const
    if (role === 'admin' && admins.length <= 1) return { ok: false, kind: 'last_admin' } as const

    await tx
      .delete(schema.orgMembers)
      .where(and(eq(schema.orgMembers.orgId, orgId), eq(schema.orgMembers.userId, userId)))
    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'member.removed',
      subjectType: 'user',
      subjectId: userId,
      data: { role },
      requestId,
    })
    return { ok: true } as const
  })
}

// ── Claim ─────────────────────────────────────────────────────────────────────────────────

/**
 * Join every org this account has an open, unexpired invitation to — **against its VERIFIED
 * email only** (ADR-0065). Called by `GET /internal/me` before it answers, so the first page
 * load after signing in is the claim.
 *
 * The email and its verified flag are read from `user` HERE rather than taken from the session:
 * the verification is the whole security of this path, since anyone can register an address
 * they do not own with email and password, and GitHub reports whether it verified one. An
 * unverified account claims nothing, however exactly its address matches.
 *
 * Race-safe without a lock: the accepting UPDATE is conditional on the invitation still being
 * open, so of two concurrent `/me` calls exactly one stamps it and writes the membership.
 *
 * @returns how many invitations were claimed, so `/me` re-reads memberships only when needed.
 */
export const claimInvitations = async ({
  db,
  clock,
  userId,
  requestId,
}: {
  db: Database
  clock: Clock
  userId: string
  requestId: string
}): Promise<number> => {
  const now = new Date(clock.now())

  const claimable = await db
    .select({
      id: schema.orgInvitations.id,
      orgId: schema.orgInvitations.orgId,
      role: schema.orgInvitations.role,
    })
    .from(schema.orgInvitations)
    .innerJoin(schema.user, eq(sql`lower(${schema.user.email})`, schema.orgInvitations.email))
    .where(
      and(
        eq(schema.user.id, userId),
        eq(schema.user.emailVerified, true),
        isOpen(),
        gt(schema.orgInvitations.expiresAt, now),
      ),
    )
  if (claimable.length === 0) return 0

  let claimed = 0
  for (const invitation of claimable) {
    const won = await db.transaction(async (tx) => {
      const [accepted] = await tx
        .update(schema.orgInvitations)
        .set({ acceptedAt: now, acceptedBy: userId, updatedAt: now })
        .where(and(eq(schema.orgInvitations.id, invitation.id), isOpen()))
        .returning({ id: schema.orgInvitations.id })
      if (accepted === undefined) return false

      // Already a member (added by another invitation that raced this one) keeps the role
      // they hold: an invitation grants a place, it does not rewrite an existing one.
      await tx
        .insert(schema.orgMembers)
        .values({
          orgId: invitation.orgId,
          userId,
          role: invitation.role,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
      await recordAuditEvent(tx, {
        orgId: invitation.orgId,
        actorType: 'user',
        actorId: userId,
        action: 'invitation.accepted',
        subjectType: 'invitation',
        subjectId: invitation.id,
        data: { role: invitation.role },
        requestId,
      })
      return true
    })
    if (won) claimed += 1
  }
  return claimed
}
