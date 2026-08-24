import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, orgRole, updatedAt } from './columns.ts'
import { orgs } from './orgs.ts'

/**
 * Membership, and the home of the `role` column (ADR-0014).
 *
 * The role lives here rather than on better-auth's `user` table because a role on `user`
 * encodes one global role per person, which the tenancy model contradicts: PRODUCT.md 5.1
 * has org-scoped roles and guest experts invited into a *specific* org, and the post-V1
 * roadmap has SMEs working across several orgs. Putting it on `user` now and moving it at
 * M4 would perform exactly the data migration that shipping the column early avoids.
 *
 * Present and UNENFORCED at M0. Nothing reads it until M4 adds authorisation; it ships now
 * because a column is cheap today and a backfill against live membership is not.
 */
export const orgMembers = pgTable(
  'org_members',
  {
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** A better-auth id, not a prefixed ULID — better-auth mints its own (ADR-0008). */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: orgRole('role').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.userId] })],
)
