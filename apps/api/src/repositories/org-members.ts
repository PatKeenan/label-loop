import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { eq } from 'drizzle-orm'

/**
 * Reading a person's organisation membership — the row that turns "who is this" into
 * "whose data may they see" (ADR-0014).
 */

/** The four roles the schema declares. Present from M0, ENFORCED from M4. */
export type OrgRole = (typeof schema.orgMembers.$inferSelect)['role']

export type Membership = {
  orgId: string
  userId: string
  role: OrgRole
}

/**
 * The one org this person belongs to, or `undefined`.
 *
 * Singular, and the schema is not: `org_members` is keyed on (org, user) precisely so a
 * person can belong to several, which the post-V1 roadmap needs for SMEs working across
 * customers. M0 has no org switcher and no way to say which org a request is about, so
 * this takes the first and the console shows one — narrowing the read rather than the
 * schema, so that the day an org picker exists this becomes a `where` clause and nothing
 * has to be migrated.
 */
export const findMembership = async (
  db: Database,
  userId: string,
): Promise<Membership | undefined> => {
  const rows = await db
    .select({
      orgId: schema.orgMembers.orgId,
      userId: schema.orgMembers.userId,
      role: schema.orgMembers.role,
    })
    .from(schema.orgMembers)
    .where(eq(schema.orgMembers.userId, userId))
    .orderBy(schema.orgMembers.createdAt)
    .limit(1)
  return rows[0]
}
