import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { apiKeyStatus, createdAt, id, idCheck, timestampAt, updatedAt } from './columns.ts'
import { orgs } from './orgs.ts'
import { panels } from './panels.ts'

/**
 * A scoped API key (ADR-0003). Only the SHA-256 hash is stored: the plaintext is rendered
 * exactly once at creation and is unrecoverable afterwards, so a database dump is not a
 * set of working credentials.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: id().primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /**
     * Every key is scoped to exactly one panel. A key presented against a different
     * panel's path is rejected as `UNAUTHORIZED` rather than `FORBIDDEN`, so the response
     * does not confirm that the other panel exists.
     */
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    /**
     * A human label, and not cosmetic. ADR-0003 gives every key its own rate limit and
     * usage meter, which is the mechanism that lets two external clients share one panel
     * with independent activity, quotas and revocation. Without a name you cannot tell
     * Client A's key from Client B's, and key management breaks the moment there is more
     * than one — B2B or not.
     */
    name: text('name').notNull(),
    /** SHA-256 of the plaintext, lowercase hex. Unique: the lookup path on every call. */
    hash: text('hash').notNull(),
    /** Shown in the console after creation, so a human can identify a key they hold. */
    last4: text('last4').notNull(),
    /** Revocation is a status flip, never a delete — the audit trail has to survive it. */
    status: apiKeyStatus('status').notNull().default('active'),
    revokedAt: timestampAt('revoked_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idCheck('api_keys', table.id, 'key_'),
    uniqueIndex('api_keys_hash_key').on(table.hash),
  ],
)
