import { newId } from '@labelloop/contracts'
import { type Database, schema } from '@labelloop/db'
import type { Clock } from '../ports/clock.ts'
import { recordAuditEvent } from '../repositories/audit-events.ts'

/**
 * Creating an organisation — the way out of "a member of nothing" (ADR-0063).
 *
 * **Three rows, one transaction.** The org, the creator's membership as `admin`, and an
 * `org.created` audit event. An org with no member is unreachable by anyone, and a member of an
 * org nobody recorded creating is history with its first line missing — so either all three
 * land or none do.
 *
 * **The creator is the admin.** Somebody has to be able to reach Organisation settings when M8
 * builds it, and the only person who exists at this moment is the one making it.
 */

export type CreateOrgInput = {
  db: Database
  clock: Clock
  userId: string
  requestId: string
  org: { slug: string; name: string }
}

export type CreateOrgResult =
  | { ok: true; orgId: string; slug: string; name: string }
  /** Another org already has this slug (`orgs_slug_key` — slugs are global, not per-anything). */
  | { ok: false; kind: 'slug_taken' }

/** Postgres `unique_violation`, on the one unique index a well-formed request can hit. */
const UNIQUE_VIOLATION = '23505'
const ORG_SLUG_CONSTRAINT = 'orgs_slug_key'

/** Drizzle may wrap the driver's error, so both depths are read (as in `create-panel.ts`). */
const isSlugTaken = (error: unknown): boolean =>
  [error, (error as { cause?: unknown } | null)?.cause].some(
    (candidate) =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as { code?: unknown }).code === UNIQUE_VIOLATION &&
      (candidate as { constraint?: unknown }).constraint === ORG_SLUG_CONSTRAINT,
  )

export const createOrg = async ({
  db,
  clock,
  userId,
  requestId,
  org,
}: CreateOrgInput): Promise<CreateOrgResult> => {
  const now = new Date(clock.now())
  const orgId = newId('org_')

  try {
    await db.transaction(async (tx) => {
      await tx.insert(schema.orgs).values({
        id: orgId,
        slug: org.slug,
        name: org.name,
        createdAt: now,
        updatedAt: now,
      })
      await tx.insert(schema.orgMembers).values({
        orgId,
        userId,
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      })
      await recordAuditEvent(tx, {
        orgId,
        actorType: 'user',
        actorId: userId,
        action: 'org.created',
        subjectType: 'org',
        subjectId: orgId,
        // The creator's role is recorded because it is the first grant in this org's history,
        // and M8's members screen will be asked where every admin came from.
        data: { slug: org.slug, name: org.name, creator_role: 'admin' },
        requestId,
      })
    })
  } catch (error) {
    if (isSlugTaken(error)) return { ok: false, kind: 'slug_taken' }
    throw error
  }

  return { ok: true, orgId, slug: org.slug, name: org.name }
}
