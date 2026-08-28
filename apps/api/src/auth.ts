import { type Database, schema } from '@labelloop/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Config } from './config.ts'

/**
 * The better-auth instance (ADR-0008). CONFIGURED here at P3; MOUNTED at P7.
 *
 * The split is deliberate (plan D-E). Its tables have to land in the same forward-only
 * migration stream as everything else, which means the schema decision — and the
 * better-auth + Drizzle + Bun seam it depends on — has to be settled while the database is
 * being designed, not two phases later when the console needs a login form. What is
 * deferred is only the handler and the session middleware.
 *
 * Two constraints shape this configuration, and both come from decisions above it:
 *
 * **Credential provider only, no social/OIDC.** Social providers need client secrets, and
 * a fresh clone must boot with none (ADR-0009). Whether email+password survives to
 * production is an explicit M4 decision, not an accident of what was easy at M0.
 *
 * **`disableMigrations`.** better-auth can create its own tables on demand. It must not:
 * that would issue DDL at application runtime, under the app role, outside the migration
 * history — three separate violations of the two-role split. Our migrations own the
 * schema; better-auth only reads and writes rows.
 */

export type AuthConfig = Pick<Config, 'NODE_ENV'> & {
  /** Where the console runs, for cookie and redirect scoping. Supplied at P7. */
  baseURL?: string
}

export const createAuth = (db: Database, config: AuthConfig) =>
  betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      // Our hand-written tables, asserted against better-auth's own expectations by
      // `packages/db/src/schema/auth.test.ts` so a version bump cannot drift silently.
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: { enabled: true },
    // The app role holds no DDL. If this were ever true, better-auth would try to create
    // tables at runtime and fail — loudly, but at the wrong time and in the wrong process.
    disableMigrations: true,
    ...(config.baseURL === undefined ? {} : { baseURL: config.baseURL }),
  })

export type Auth = ReturnType<typeof createAuth>
