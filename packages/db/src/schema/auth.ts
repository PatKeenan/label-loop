import { boolean, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, timestampAt, updatedAt } from './columns.ts'

/**
 * better-auth's own tables (ADR-0008), declared here so they land in the SAME
 * forward-only migration stream as everything else. One migration history, one migrator
 * role, one `bun run db:migrate` — rather than an auth library reaching for the database
 * on its own schedule with its own privileges.
 *
 * These four are better-auth's contract, not ours, which is why they break our conventions
 * in two visible ways: the ids are better-auth's (it mints them; they carry no `usr_`
 * prefix), and the property names are camelCase because the Drizzle adapter matches
 * better-auth's field names against the schema object's KEYS. The SQL column names stay
 * snake_case like the rest of the database.
 *
 * `auth.test.ts` asserts these tables against better-auth's own `getAuthTables()`, so a
 * version bump that adds or renames a field fails a test rather than failing at runtime
 * on someone's login. That check is the reason these are hand-written rather than
 * generated once and left to drift.
 *
 * The handler and session middleware mount at P7; only the schema lands here (plan D-E).
 */

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestampAt('expires_at').notNull(),
    token: text('token').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('session_token_key').on(table.token)],
)

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  issuer: text('issuer').notNull(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestampAt('access_token_expires_at'),
  refreshTokenExpiresAt: timestampAt('refresh_token_expires_at'),
  scope: text('scope'),
  /**
   * The credential provider's password hash (ADR-0008: email + password only at M0; no
   * social providers, because their client secrets would break zero-secret boot).
   * better-auth hashes it — nothing in this repo ever sees a plaintext password.
   */
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestampAt('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})
