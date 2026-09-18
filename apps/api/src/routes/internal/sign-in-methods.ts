import { Hono } from 'hono'
import type { AppEnv } from '../../app-env.ts'

/**
 * `GET /internal/sign-in-methods` — which doors the login screen should draw. Public: it is
 * asked BEFORE anyone is signed in, so it is registered ahead of `sessionAuth()`.
 *
 * It exists because the console had been assuming. The phase 2 GitHub button rendered
 * whether or not the API had GitHub credentials, and a click on a clone with none came back
 * `PROVIDER_NOT_FOUND` (Deviation 11). The password form has the mirror-image problem: it is
 * disabled in production (ADR-0049) and was drawn there anyway, a form that could only fail.
 *
 * **Read off better-auth's own options, not recomputed from config.** `auth.ts` decides
 * which providers exist; re-deriving the same answer here from `NODE_ENV` and the GitHub
 * pair would be a second copy of that decision, and the copy is what would drift. Reading
 * the options the handler was built with makes "the screen offers it" and "the handler
 * accepts it" the same fact.
 *
 * Nothing here is secret. Whether a deployment accepts GitHub sign-in is visible to anyone
 * who clicks the button; this saves them the click.
 */
export const createSignInMethodRoutes = () =>
  new Hono<AppEnv>().get('/sign-in-methods', (c) => {
    const { options } = c.var.deps.auth
    return c.json({
      data: {
        email_password: options.emailAndPassword?.enabled === true,
        github: options.socialProviders?.github !== undefined,
      },
      request_id: c.var.requestId,
    })
  })
