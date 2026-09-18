#!/usr/bin/env bun
import { createAuth } from '@labelloop/api/auth'
import { createDatabase } from '@labelloop/db'
import { envOr, requireEnv } from './env.ts'

/**
 * A LOCAL account whose email counts as VERIFIED — so an invitation can be claimed on a
 * development machine without a second GitHub account (M5 plan, Deviation 16).
 *
 *     bun run dev:account someone@example.com
 *
 * The claim only honours a verified email (ADR-0065), and locally the only thing that verifies
 * one is GitHub. An email-and-password account is unverified by construction — nothing sends
 * the confirming email — so it can never claim, which is correct in production and a dead end
 * in development. This stands in for "GitHub said this address is theirs": it creates the
 * account through better-auth's own sign-up (hashing stays in the library, as the seed does)
 * and sets `email_verified`. It does NOT add a membership — joining is the claim's job, and the
 * claim is what is being tested.
 *
 * It refuses anything that is not a local development database. Marking an address verified by
 * hand is exactly the act the claim's security rests on nobody being able to do.
 */

const email = process.argv[2]?.trim().toLowerCase()
if (email === undefined || email === '' || !email.includes('@')) {
  console.error('usage: bun run dev:account <email>')
  process.exit(1)
}

if (process.env.NODE_ENV === 'production') {
  console.error('refusing: NODE_ENV is production — this marks an email verified by hand')
  process.exit(1)
}
const url = requireEnv('DATABASE_URL')
const host = new URL(url).hostname
if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
  console.error(`refusing: DATABASE_URL points at "${host}", not a local database`)
  process.exit(1)
}

const password = envOr('SEED_USER_PASSWORD', 'localdev-password')
const db = createDatabase({ url, max: 1 })

const existing = (await db.client`SELECT id FROM "user" WHERE lower(email) = ${email}`)[0] as
  | { id: string }
  | undefined

if (existing === undefined) {
  await createAuth(db, {
    // As in `seed.ts`: well-formed values for an in-process sign-up that issues no cookie
    // anyone keeps, and NODE_ENV pinned because the password provider is off in production.
    BETTER_AUTH_SECRET: 'dev-account-script-not-a-secret',
    API_BASE_URL: 'http://localhost:3000',
    WEB_ORIGIN: 'http://localhost:5173',
    NODE_ENV: 'development',
  }).api.signUpEmail({ body: { email, password, name: email.split('@')[0] ?? email } })
}
await db.client`UPDATE "user" SET email_verified = true WHERE lower(email) = ${email}`
await db.close()

console.log(
  existing === undefined
    ? `created ${email} / ${password}, email marked verified`
    : `${email} already existed — email marked verified (its password is unchanged)`,
)
console.log(
  'sign in with it; any open invitation to this address is claimed on the first page load',
)
