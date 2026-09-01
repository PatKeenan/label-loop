#!/usr/bin/env bun
import { createAuth } from '@labelloop/api/auth'
import { type IdPrefix, isId, type ModelPinValidation, modelRefOf } from '@labelloop/contracts'
import { createDatabase, type Database } from '@labelloop/db'
import { createFakeProvider } from '../apps/api/src/llm/fake-provider.ts'
import { createOpenRouterProvider } from '../apps/api/src/llm/openrouter-provider.ts'
import { createProviderRegistry } from '../apps/api/src/llm/provider-registry.ts'
import { envOr, requireEnv } from './env.ts'
import { resolveSeededJudges, type SeededJudge, validateSeededPins } from './seed-judges.ts'

/**
 * Deterministic seed data (plan D-L). Every id and the dev API key are FIXED rather than
 * random, because the README's curl has to work verbatim on a fresh clone — a random key
 * would mean a copy-paste step, and the one-command claim would quietly stop being true.
 *
 * Idempotent: re-running it is a no-op rather than an error or a duplicate, so it can sit
 * in the compose one-shot at P8 and run on every `docker compose up`.
 *
 * WHICH judges, which models and which pins is `seed-judges.ts`; this file is the writing
 * of them. The split is so that everything decidable without a database — and everything
 * that can cost money — is testable without one.
 */

const db = createDatabase({ url: requireEnv('DATABASE_URL'), max: 2 })

/**
 * A fixed, valid prefixed ULID.
 *
 * The label must be Crockford base32, which excludes I, L, O and U — they are omitted
 * precisely because they are the characters people misread. That makes readable labels
 * surprisingly hard to write by hand, so this asserts rather than trusts: an unusable
 * label fails here, naming itself, instead of arriving as a check-constraint violation
 * from Postgres with no clue as to which of a dozen ids was wrong.
 */
const seedId = <P extends IdPrefix>(prefix: P, label: string): string => {
  const id = `${prefix}${label.padStart(26, '0')}`
  if (!isId(prefix, id)) {
    throw new Error(
      `seed label "${label}" does not make a valid ${prefix} id — ` +
        'Crockford base32 excludes I, L, O and U, and the label must fit in 26 characters',
    )
  }
  return id
}

const ORG = seedId('org_', 'SEED0RG')
const PANEL = seedId('pnl_', 'SEEDPANE')
const PANEL_VERSION = seedId('pnv_', 'SEEDPANEV1')
const API_KEY = seedId('key_', 'SEEDKEY')

/**
 * The local development key. Deliberately zero-entropy and self-describing: it is a real
 * credential in shape only, on a throwaway local database, and it is committed in the
 * README. A realistic-looking random literal here would be indistinguishable from a leaked
 * key — to a scanner and to a reader — which is the lesson the P2 gitleaks failure taught.
 */
const DEV_KEY_PLAINTEXT = `llk_test_${'0'.repeat(64)}`

/**
 * The console login, so a fresh clone can sign in (P7). Same reasoning as the key above and
 * one extra constraint: nothing here ever sees a password HASH. The account is created by
 * calling better-auth's own sign-up endpoint in-process, so hashing stays entirely inside
 * the library that owns it (ADR-0008) — writing a hash by hand would mean this script
 * encoding better-auth's algorithm, and drifting silently the day it changes.
 */
const SEED_USER_EMAIL = envOr('SEED_USER_EMAIL', 'demo@labelloop.test')
const SEED_USER_PASSWORD = envOr('SEED_USER_PASSWORD', 'localdev-password')
const SEED_USER_NAME = 'Demo Operator'

const sha256 = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')

/**
 * What the four judges are, decided from the environment before anything is opened or
 * written. It throws naming the variable when one is wrong, which is why it runs here
 * rather than inside the loop that would otherwise discover it halfway through a write.
 */
const judges = resolveSeededJudges()

/**
 * The same registry the API composes (`server.ts`), for the same reason: pin validation is
 * an ordinary `evaluate()` call (ADR-0026), so it should go down the real dispatch path
 * rather than a second one written for the seed. The OpenRouter adapter is registered only
 * when a key is present — and `resolveSeededJudges` has already refused any configuration
 * that would need one and not have it, so an absent adapter here is never reachable.
 */
const provider = createProviderRegistry({
  providers: {
    fake: createFakeProvider(),
    ...(process.env.OPENROUTER_API_KEY === undefined || process.env.OPENROUTER_API_KEY === ''
      ? {}
      : { openrouter: createOpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY }) }),
  },
})

type SeededJudgeRow = SeededJudge & {
  judgeId: string
  judgeVersionId: string
  /** Read back rather than carried forward, so a re-run prints the frozen row's own. */
  validation: ModelPinValidation | null
}

const seed = async (): Promise<SeededJudgeRow[]> => {
  const client = db.client

  await client`
    INSERT INTO orgs (id, slug, name) VALUES (${ORG}, 'demo', 'LabelLoop Demo')
    ON CONFLICT (id) DO NOTHING
  `
  await client`
    INSERT INTO panels (id, org_id, slug, name)
    VALUES (${PANEL}, ${ORG}, 'issue-triage', 'Issue triage')
    ON CONFLICT (id) DO NOTHING
  `
  await client`
    INSERT INTO panel_versions (id, panel_id, version, threshold)
    VALUES (${PANEL_VERSION}, ${PANEL}, 1, 0.5)
    ON CONFLICT (id) DO NOTHING
  `

  const rows = judges.map((judge, index) => ({
    ...judge,
    judgeId: seedId('jud_', `SEEDJDG${index}`),
    judgeVersionId: seedId('jdv_', `SEEDJDGV${index}`),
  }))
  const versionIds = rows.map((row) => row.judgeVersionId)

  // **Idempotency is what makes this affordable.** A `jdv_` is frozen (ADR-0003), so a row
  // that exists has a pin that can never change and a validation that can never be made
  // more true — re-probing it would buy a fact already on the row, on every `docker compose
  // up`, forever. So the rows that exist are read first and only the missing ones are
  // validated, which is also what keeps the second run silent and offline.
  const frozen = new Set(
    (
      await client<{ id: string }>`
        SELECT id FROM judge_versions WHERE id = ANY(${versionIds}::text[])
      `
    ).map((row) => row.id),
  )
  const validations = await validateSeededPins({
    judges: rows.filter((row) => !frozen.has(row.judgeVersionId)),
    provider,
    now: () => new Date(),
  })

  for (const judge of rows) {
    await client`
      INSERT INTO judges (id, panel_id, slug, name)
      VALUES (${judge.judgeId}, ${PANEL}, ${judge.slug}, ${judge.name})
      ON CONFLICT (id) DO NOTHING
    `
    await client`
      INSERT INTO judge_versions
        (id, judge_id, version, type, polarity, weight, required, question, model,
         model_pin, model_pin_validation)
      VALUES (
        ${judge.judgeVersionId}, ${judge.judgeId}, 1, 'llm', ${judge.polarity}::judge_polarity,
        ${judge.weight}, ${judge.required}, ${judge.question}, ${judge.model},
        -- Every llm judge carries a pin, fake: ones included (ADR-0025), so the CHECK can
        -- be the clean mirror of the model/type rule.
        --
        -- Bound as an OBJECT, never JSON.stringify'd first. Under node-postgres (ADR-0031)
        -- both spellings are in fact correct, which is the point of that driver swap: the
        -- double-encoding jsonb-encoding.test.ts exists to catch is unrepresentable here
        -- rather than merely avoided.
        ${judge.pin}::jsonb,
        -- Null on a re-run, and never overwritten -- the ON CONFLICT below means the
        -- observation on a frozen row stays the one taken when it froze.
        ${validations.get(judge.slug) ?? null}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `
    // The membership row is what makes the panel version pin its judge set, and so what
    // makes its immutability mean anything.
    await client`
      INSERT INTO panel_version_judges (panel_version_id, judge_version_id)
      VALUES (${PANEL_VERSION}, ${judge.judgeVersionId})
      ON CONFLICT DO NOTHING
    `
  }

  // Activation is a separate act from creation: the version exists, then it is pointed at.
  // Doing it in one INSERT would be impossible anyway — the version cannot be referenced
  // before it is written.
  await client`
    UPDATE panels SET current_version_id = ${PANEL_VERSION} WHERE id = ${PANEL}
  `

  await client`
    INSERT INTO api_keys (id, org_id, panel_id, name, hash, last4)
    VALUES (
      ${API_KEY}, ${ORG}, ${PANEL}, 'Local development',
      ${sha256(DEV_KEY_PLAINTEXT)}, ${DEV_KEY_PLAINTEXT.slice(-4)}
    )
    ON CONFLICT (id) DO NOTHING
  `

  await seedConsoleUser(client)

  // Read back rather than reported from memory. On a re-run nothing was validated, and the
  // honest thing to print is what the frozen row actually holds — which is also the only
  // way the output distinguishes "validated just now" from "validated in June".
  const observed = new Map(
    (
      await client<{ id: string; model_pin_validation: ModelPinValidation | null }>`
        SELECT id, model_pin_validation FROM judge_versions WHERE id = ANY(${versionIds}::text[])
      `
    ).map((row) => [row.id, row.model_pin_validation] as const),
  )
  return rows.map((row) => ({ ...row, validation: observed.get(row.judgeVersionId) ?? null }))
}

/**
 * The console account, and the one part of the seed that goes through the application
 * rather than straight to SQL.
 *
 * better-auth mints its own ids and owns its own password hashing (ADR-0008), so this asks
 * IT to create the account instead of writing `user` and `account` rows by hand. That costs
 * determinism — the user id is whatever better-auth generates — and buys the thing that
 * matters more: the credential this seed creates is verified by exactly the code path that
 * will later check it, so "the README's login works" is proven rather than hoped.
 *
 * Idempotency is therefore a check-then-act rather than an `ON CONFLICT`, which is
 * acceptable here and nowhere else: a seed script is single-writer by construction.
 */
const seedConsoleUser = async (client: Database['client']) => {
  const existing = await client`SELECT id FROM "user" WHERE email = ${SEED_USER_EMAIL} LIMIT 1`
  const found = existing[0] as { id: string } | undefined

  const userId =
    found?.id ??
    (
      await createAuth(db, {
        // The seed signs up locally and never issues a cookie anyone keeps, so these three
        // only have to be well-formed. The API's own boot-time config is what governs the
        // running server's.
        BETTER_AUTH_SECRET: 'seed-script-not-a-secret',
        API_BASE_URL: 'http://localhost:3000',
        WEB_ORIGIN: 'http://localhost:5173',
      }).api.signUpEmail({
        body: { email: SEED_USER_EMAIL, password: SEED_USER_PASSWORD, name: SEED_USER_NAME },
      })
    ).user.id

  // Membership, not a role on `user` (ADR-0014). `admin` because this is the account that
  // owns the demo org; the column is unenforced until M4.
  await client`
    INSERT INTO org_members (org_id, user_id, role)
    VALUES (${ORG}, ${userId}, 'admin'::org_role)
    ON CONFLICT (org_id, user_id) DO NOTHING
  `
}

const seeded = await seed()
await db.close()

// Rendered exactly once at creation is the RULE for real keys (ADR-0003); this one is
// printed on every seed because it is a fixed local credential, not a secret, and the
// README quotes it verbatim. Production key issuance shows the plaintext once and stores
// only the hash — which is why `api_keys` has no column that could hold it.
console.log(`seeded org ${ORG}`)
console.log(`  panel  ${PANEL} (issue-triage), live @ ${PANEL_VERSION}, threshold 0.5`)
console.log(`  key    ${DEV_KEY_PLAINTEXT}`)
console.log(`  login  ${SEED_USER_EMAIL} / ${SEED_USER_PASSWORD} (the console)`)
console.log('  judges')
for (const judge of seeded) {
  // The model and the effort are what the row is FROZEN against, and the endpoint count is
  // what a real call observed when it froze. Printing all three is what makes a paid seed
  // legible — three labs, three prices, three different amounts of failover.
  //
  // A `fake:` route says so rather than reporting `0 endpoints`. The zero is the honest
  // number in the column — there is nothing to route among — but printed as a count it
  // reads like a routing failure, which is the opposite of what it means.
  const routing =
    modelRefOf(judge.model)?.route === 'fake'
      ? 'offline, no endpoints to route among'
      : judge.validation === null
        ? 'not validated'
        : `${judge.validation.available_endpoints} endpoints`
  console.log(
    `    ${judge.slug.padEnd(12)} ${judge.model.padEnd(38)} ` +
      `effort ${judge.pin.reasoning.effort.padEnd(7)} ${routing}`,
  )
}
