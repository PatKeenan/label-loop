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
 * **Which doors are open depends on the environment, and M4 answered the question M0 left
 * open.** The header here used to say "credential provider only, no social/OIDC", with a
 * note that whether email+password survives to production was "an explicit M4 decision,
 * not an accident of what was easy at M0". This is that decision (ADR-0049):
 *
 * - **GitHub is registered when, and only when, both of its credentials are present.** A
 *   fresh clone has neither and must still boot (ADR-0009), so absence is a supported
 *   state rather than a degraded one — the seeded password account is the way in.
 * - **`emailAndPassword` is enabled everywhere EXCEPT production.** Disabled rather than
 *   removed, and the distinction is the whole point: the M0 demo, CI, and every
 *   database-backed test in this repo sign in with a password, so deleting the provider
 *   would trade a production hole for a broken local story. Production is the one place a
 *   seeded account with a committed password is a way in for anybody who read the repo.
 *
 * The two rules meet in `config.ts`, which is what stops the combination that has neither:
 * in production the GitHub pair is REQUIRED, because with credentials disabled it is the
 * only door and an image without it locks out its own operator.
 *
 * **`disableMigrations`.** better-auth can create its own tables on demand. It must not:
 * that would issue DDL at application runtime, under the app role, outside the migration
 * history — three separate violations of the two-role split. Our migrations own the
 * schema; better-auth only reads and writes rows.
 *
 * **No organization plugin** (ADR-0048). better-auth ships one, and it is not registered:
 * it would own the tenancy tables ADR-0014 deliberately kept as ours, and it stores the
 * active org as a column on the `session` row — the design ADR-0047 rejected. better-auth
 * answers one question here, and it is "who is this".
 */

export type AuthConfig = Pick<
  Config,
  | 'BETTER_AUTH_SECRET'
  | 'API_BASE_URL'
  | 'WEB_ORIGIN'
  | 'NODE_ENV'
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
>

/**
 * The GitHub provider, or nothing at all.
 *
 * The return type is written out rather than inferred so it is ONE type with an optional
 * key, not a union of two shapes — `Auth` is better-auth's inferred endpoint surface, and a
 * union here would make that type depend on a runtime value.
 *
 * Both credentials or neither, never one: `config.ts` rejects half a pair at boot, so by the
 * time this runs the undefined case means "nobody configured GitHub", not "somebody made a
 * typo". The callback GitHub must be told about is `baseURL` + `basePath` + `/callback/github`
 * — `http://localhost:3000/internal/auth/callback/github` with the local defaults.
 */
const githubProvider = (
  config: AuthConfig,
): { github?: { clientId: string; clientSecret: string } } => {
  const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } = config
  if (clientId === undefined || clientSecret === undefined) return {}
  return { github: { clientId, clientSecret } }
}

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
    // Disabled in production ONLY (ADR-0049). Every database-backed test in this repo and
    // the M0 demo sign in with a password, so removing the provider outright would trade a
    // production hole for a broken local story.
    emailAndPassword: { enabled: config.NODE_ENV !== 'production' },
    socialProviders: githubProvider(config),
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
