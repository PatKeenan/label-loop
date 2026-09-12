import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { inArray } from 'drizzle-orm'
import { createAuth } from './auth.ts'
import type { Config } from './config.ts'

/**
 * Which doors are open, per environment (M4 phase 2, ADR-0049).
 *
 * `config.test.ts` owns whether the VARIABLES are accepted; this file owns what better-auth
 * actually does with them, which is a different question and the one that can regress
 * silently. A provider can be configured and unregistered, and the symptom is a button that
 * does nothing rather than an error anybody sees.
 *
 * Asserted through `auth.handler` — a real `Request` in, a real `Response` out — rather than
 * against `auth.options`, which would only prove we passed what we passed. Against a real
 * Postgres, because better-auth writes an OAuth state row before it will hand back an
 * authorization URL, so the happy path does not exist without one.
 *
 * **The redirect URI is pinned here on purpose.** It is the value an operator pastes into
 * GitHub's OAuth app settings, it is derived rather than configured — `API_BASE_URL` +
 * `basePath` + `/callback/github` — and a mismatch is the single most common way this setup
 * fails, with GitHub reporting the error rather than us. `.env.example` documents the same
 * string, and this test is what stops the two from drifting.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the auth configuration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

/** Long enough that better-auth does not warn about entropy, and obviously not a secret. */
const SECRET = 'auth-test-not-a-secret-0000000000000000'
const API_BASE_URL = 'http://localhost:3000'
const WEB_ORIGIN = 'http://localhost:5173'

/** What GitHub must be told, and what `.env.example` tells the operator to paste. */
const EXPECTED_CALLBACK = `${API_BASE_URL}/internal/auth/callback/github`

const GITHUB = {
  GITHUB_CLIENT_ID: 'Iv1.notarealclientid',
  GITHUB_CLIENT_SECRET: 'not-a-real-client-secret',
} as const

type AuthEnv = Partial<Config> & { NODE_ENV: Config['NODE_ENV'] }

let db: Database
/** OAuth state rows better-auth writes on the happy path, removed in `afterAll`. */
const statesWritten: string[] = []

const authFor = (env: AuthEnv) =>
  createAuth(db, { BETTER_AUTH_SECRET: SECRET, API_BASE_URL, WEB_ORIGIN, ...env })

const post = async (env: AuthEnv, path: string, body: unknown) => {
  const response = await authFor(env).handler(
    new Request(`${API_BASE_URL}/internal/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify(body),
    }),
  )
  return { status: response.status, body: (await response.json()) as Record<string, unknown> }
}

const signInWithPassword = (env: AuthEnv) =>
  post(env, '/sign-in/email', {
    email: 'nobody-auth-test@labelloop.test',
    password: 'localdev-password',
  })

const signInWithGithub = async (env: AuthEnv) => {
  const result = await post(env, '/sign-in/social', {
    provider: 'github',
    callbackURL: `${WEB_ORIGIN}/`,
  })
  const url = typeof result.body.url === 'string' ? new URL(result.body.url) : undefined
  const state = url?.searchParams.get('state')
  if (state !== null && state !== undefined) statesWritten.push(state)
  return { ...result, url }
}

beforeAll(() => {
  db = createDatabase({ url: DATABASE_URL, max: 2 })
})

afterAll(async () => {
  if (statesWritten.length > 0) {
    await db
      .delete(schema.verification)
      .where(inArray(schema.verification.identifier, statesWritten))
  }
  await db.close()
})

describe('the password door', () => {
  test('is OPEN in development — ADR-0009’s zero-secret boot depends on it', () => {
    // The property most at risk in this phase. The M0 demo, CI and every database-backed
    // test in this repo sign in with a password; disabling it everywhere would trade a
    // production hole for a broken local story.
    return signInWithPassword({ NODE_ENV: 'development' }).then((result) => {
      // A real rejection of a real (nonexistent) account, which means the endpoint RAN.
      expect(result.body.code).not.toBe('EMAIL_PASSWORD_DISABLED')
      expect(result.status).not.toBe(400)
    })
  })

  test('is OPEN in test, so the suite can sign in', async () => {
    const result = await signInWithPassword({ NODE_ENV: 'test' })
    expect(result.body.code).not.toBe('EMAIL_PASSWORD_DISABLED')
  })

  test('is SHUT in production, and says so', async () => {
    // The seeded account's password is committed in `scripts/seed.ts`, so in production it
    // is a way in for anyone who has read the repository.
    const result = await signInWithPassword({ NODE_ENV: 'production' })
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('EMAIL_PASSWORD_DISABLED')
  })
})

describe('the GitHub door', () => {
  test('is not registered at all when neither credential is set', async () => {
    // Absence is a supported state, not a degraded one: a fresh clone has no `.env`.
    const result = await signInWithGithub({ NODE_ENV: 'development' })
    expect(result.status).toBe(404)
    expect(result.body.code).toBe('PROVIDER_NOT_FOUND')
  })

  test.each([
    ['id only', { GITHUB_CLIENT_ID: GITHUB.GITHUB_CLIENT_ID }],
    ['secret only', { GITHUB_CLIENT_SECRET: GITHUB.GITHUB_CLIENT_SECRET }],
  ])('is not registered with %s — both, or neither', async (_name, half) => {
    // `config.ts` refuses half a pair at boot, so this is belt and braces. It is here
    // because the two rules have to agree: if this file ever registered on one credential,
    // the boot check would be rejecting a configuration that actually worked.
    const result = await signInWithGithub({ NODE_ENV: 'development', ...half })
    expect(result.status).toBe(404)
  })

  test('is registered when both are set, and points at GitHub', async () => {
    const result = await signInWithGithub({ NODE_ENV: 'development', ...GITHUB })

    expect(result.status).toBe(200)
    expect(result.url?.origin).toBe('https://github.com')
    expect(result.url?.pathname).toBe('/login/oauth/authorize')
    expect(result.url?.searchParams.get('client_id')).toBe(GITHUB.GITHUB_CLIENT_ID)
  })

  test('sends GitHub the callback an operator must register, derived not configured', async () => {
    const result = await signInWithGithub({ NODE_ENV: 'development', ...GITHUB })
    expect(result.url?.searchParams.get('redirect_uri')).toBe(EXPECTED_CALLBACK)
  })

  test('and it is the ONLY door in production', async () => {
    // The combination `config.ts` exists to prevent by requiring the pair in production:
    // credentials shut, GitHub open. With neither, nobody can sign in at all.
    const production = { NODE_ENV: 'production', ...GITHUB } as const
    expect((await signInWithPassword(production)).body.code).toBe('EMAIL_PASSWORD_DISABLED')
    expect((await signInWithGithub(production)).status).toBe(200)
  })
})
