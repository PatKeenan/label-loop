import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { eq } from 'drizzle-orm'

/**
 * Reading a person's organisation memberships — the rows that turn "who is this" into
 * "whose data may they see" (ADR-0014).
 */

/** The four roles the schema declares. Present from M0, ENFORCED from M4. */
export type OrgRole = (typeof schema.orgMembers.$inferSelect)['role']

export type Membership = {
  orgId: string
  userId: string
  role: OrgRole
  /**
   * Carried so a switcher can render a name rather than a ULID. The read is a join
   * either way — `org_members` holds no name — and doing it here is what lets
   * `GET /internal/me` answer the switcher in one round trip (ADR-0047).
   */
  orgName: string
  orgSlug: string
}

/**
 * EVERY org this person belongs to, oldest membership first.
 *
 * This used to be `findMembership`, singular, taking the first row — a deliberate
 * narrowing of the read rather than of the schema, on the note that "the day an org picker
 * exists this becomes a `where` clause and nothing has to be migrated". M4 is that day, and
 * it went the other way: the picker needs the whole list to render, and `sessionAuth` needs
 * the whole list to validate a requested org against. One query answers both.
 *
 * **The ordering is load-bearing, not incidental.** `sessionAuth` falls back to the first
 * row when no org is requested, so a non-deterministic order would mean a request without
 * the header could resolve to a different org on consecutive calls.
 */
export const listMemberships = async (db: Database, userId: string): Promise<Membership[]> => {
  return db
    .select({
      orgId: schema.orgMembers.orgId,
      userId: schema.orgMembers.userId,
      role: schema.orgMembers.role,
      orgName: schema.orgs.name,
      orgSlug: schema.orgs.slug,
    })
    .from(schema.orgMembers)
    .innerJoin(schema.orgs, eq(schema.orgs.id, schema.orgMembers.orgId))
    .where(eq(schema.orgMembers.userId, userId))
    .orderBy(schema.orgMembers.createdAt)
}
