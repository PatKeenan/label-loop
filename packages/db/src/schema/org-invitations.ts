import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, id, idCheck, orgRole, timestampAt, updatedAt } from './columns.ts'
import { orgs } from './orgs.ts'

/**
 * A pending place in an organisation, waiting for its person to sign in (ADR-0065).
 *
 * An admin invites an EMAIL with a ROLE. Nothing is sent — there is no email provider, which
 * is a stakeholder-owned stack decision — and the invitation is claimed on the account's next
 * `GET /internal/me` when its **verified** email matches. Claiming inserts the `org_members`
 * row and stamps this one accepted, in one transaction with its audit event. Emails can be
 * layered on later without changing this table.
 *
 * The row is never deleted: revoking and accepting are stamps, so "who was invited, by whom,
 * and what became of it" survives, as a revoked key does.
 */
export const orgInvitations = pgTable(
  'org_invitations',
  {
    id: id('inv_').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /**
     * Stored lowercased (and CHECKed so), because the claim compares it to the account's email
     * and `Pat@Example.com` and `pat@example.com` are one inbox. Normalising on write keeps the
     * comparison an index lookup rather than a `lower()` on every row.
     */
    email: text('email').notNull(),
    role: orgRole('role').notNull(),
    /** RESTRICT, as authorship is (`authored.ts`): who granted access is history. */
    invitedBy: text('invited_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** 14 days after creation (ADR-0065): a forgotten invitation should not grant access later. */
    expiresAt: timestampAt('expires_at').notNull(),
    acceptedAt: timestampAt('accepted_at'),
    acceptedBy: text('accepted_by').references(() => user.id, { onDelete: 'restrict' }),
    revokedAt: timestampAt('revoked_at'),
  },
  (table) => [
    idCheck('org_invitations', table.id, 'inv_'),
    check('org_invitations_email_lowercase', sql`${table.email} = lower(${table.email})`),
    // Accepted is one fact recorded in two columns; half of it is not a state.
    check(
      'org_invitations_accepted_pair',
      sql`(${table.acceptedAt} IS NULL) = (${table.acceptedBy} IS NULL)`,
    ),
    // An invitation ends one way.
    check(
      'org_invitations_one_ending',
      sql`${table.acceptedAt} IS NULL OR ${table.revokedAt} IS NULL`,
    ),
    // One OPEN invitation per person per org. Expiry cannot be in the predicate (`now()` is
    // not immutable), so the service closes an expired one before inviting the same email again.
    uniqueIndex('org_invitations_open_key')
      .on(table.orgId, table.email)
      .where(sql`${table.acceptedAt} IS NULL AND ${table.revokedAt} IS NULL`),
    // The claim's lookup: open invitations for one email, across every org.
    index('org_invitations_email_idx').on(table.email),
  ],
)
