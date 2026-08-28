import type { Auth } from '../auth.ts'

/**
 * A better-auth stand-in for the tests that are not about authentication.
 *
 * Most of the API's tests are about routing, the envelope and the logger; giving them a
 * real better-auth would mean a real Postgres and a real password hash for a login none of
 * them perform. The tests that ARE about the session path use a real one, against a real
 * database, in `middleware/session.test.ts`.
 *
 * It answers the two calls the app actually makes of it — `handler` for `/internal/auth/*`
 * and `api.getSession` for the guard — and nothing else. Anything reaching past that wants
 * the real instance rather than a richer fake that drifts from what better-auth does.
 */

export type FakeSession = {
  user: { id: string; email: string }
}

export type FakeAuthOptions = {
  /** Who the cookie resolves to. `undefined` means every request is unauthenticated. */
  session?: FakeSession
}

export const fakeAuth = ({ session }: FakeAuthOptions = {}): Auth =>
  // The single cast in this file, and the reason for it: `Auth` is better-auth's full
  // inferred endpoint surface — several hundred routes — and structurally satisfying it
  // would mean reimplementing the library.
  ({
    handler: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    api: { getSession: async () => session ?? null },
  }) as unknown as Auth
