import type { AppType } from '@labelloop/api/app'
import { createAuthClient } from 'better-auth/client'
import { hc } from 'hono/client'

/**
 * The console's two clients, and the only two places this app knows a URL.
 *
 * Both point at the same API and both carry cookies, but they are separate objects because
 * they answer to separate things: `api` is our own surface, typed by inference from the
 * server's route definitions, and `auth` is better-auth's, typed by better-auth.
 */

/**
 * Where the API is. Vite inlines this at build time from the repo-root `.env`
 * (`envDir` in `vite.config.ts`); the fallback is the same value `config.ts` defaults
 * `API_BASE_URL` to, so a clone with no `.env` still runs against a local API.
 */
export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3000'

/**
 * The typed client for `/internal`.
 *
 * `AppType` is imported from the API's SOURCE — no codegen, no generated client, no
 * schema to regenerate. A route that changes shape breaks this app's typecheck in the
 * same commit, which is the property the whole arrangement exists for. (ADR-0002 rules out
 * a published SDK for customers; this client ships in the same repo and is not one.)
 *
 * `credentials: 'include'` on every call is what makes the session cookie travel: the
 * console and the API are different ORIGINS in development, so the browser omits cookies
 * unless asked. They are the same SITE, though — cookies ignore ports — so `SameSite=Lax`
 * is enough and nothing here needs `Secure`-only cross-site cookies.
 */
export const api = hc<AppType>(API_URL, { init: { credentials: 'include' } })

/**
 * better-auth's client, pointed at where the handler is actually mounted. `basePath` is
 * stated because ours is not the library's `/api/auth` default — the console's endpoints
 * live under `/internal` with the rest of the console's surface.
 */
export const auth = createAuthClient({
  baseURL: API_URL,
  basePath: '/internal/auth',
  fetchOptions: { credentials: 'include' },
})
