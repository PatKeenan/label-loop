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

export type AuthConfig = Pick<Config, 'BETTER_AUTH_SECRET' | 'API_BASE_URL' | 'WEB_ORIGIN'>

/**
 * Where better-auth's own endpoints are mounted, and the one string the API and the
 * console must agree on. It lives under `/internal` rather than at better-auth's `/api/auth`
 * default because the split that matters here is by AUDIENCE, not by library: everything
 * under `/internal` belongs to the console and answers to a session cookie, and everything
 * under `/v1` belongs to a customer's agent and answers to a panel-scoped API key. Signing
 * in is a console act, so it lives with the console.
 *
 * Exported rather than inlined because `routes/internal/index.ts` mounts the handler at this
 * path and better-auth is told the same value; a mismatch between the two would produce
 * 404s from a library that looks correctly configured.
 */
export const AUTH_BASE_PATH = '/internal/auth'

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
    basePath: AUTH_BASE_PATH,
    // The origin a BROWSER uses to reach this API, which is what cookie scope is computed
    // from. Stated rather than inferred from request headers: inference is a `Host` header
    // away from being attacker-controlled, and a boot-time value is one an operator can be
    // told they got wrong.
    baseURL: config.API_BASE_URL,
    secret: config.BETTER_AUTH_SECRET,
    // The console is served from a different ORIGIN than the API in development (Vite on
    // 5173, the API on 3000), so better-auth has to be told that origin is ours. It is an
    // allow-list of one; CORS in `routes/internal/index.ts` is told the same value.
    trustedOrigins: [config.WEB_ORIGIN],
    // The app role holds no DDL. If this were ever true, better-auth would try to create
    // tables at runtime and fail — loudly, but at the wrong time and in the wrong process.
    disableMigrations: true,
  })

export type Auth = ReturnType<typeof createAuth>
