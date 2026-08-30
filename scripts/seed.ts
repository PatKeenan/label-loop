#!/usr/bin/env bun
import { createAuth } from '@labelloop/api/auth'
import { DEFAULT_FAKE_PIN, type IdPrefix, isId } from '@labelloop/contracts'
import { createDatabase, type Database } from '@labelloop/db'
import { envOr, requireEnv } from './env.ts'

/**
 * Deterministic seed data (plan D-L). Every id and the dev API key are FIXED rather than
 * random, because the README's curl has to work verbatim on a fresh clone — a random key
 * would mean a copy-paste step, and the one-command claim would quietly stop being true.
 *
 * Idempotent: re-running it is a no-op rather than an error or a duplicate, so it can sit
 * in the compose one-shot at P8 and run on every `docker compose up`.
 *
 * The seeded panel is the one PRODUCT.md names as tenant #1 — issue triage — because it is
 * the case that exercises all three polarities. Three of its judges are informational
 * labels with no valence, and one is a real gate; a panel of a single scoring judge would
 * have demonstrated none of that.
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

type JudgeSeed = {
  slug: string
  name: string
  question: string
  polarity: 'passes' | 'fails' | 'does_not_score'
  weight: number | null
  required: boolean
}

const JUDGES: JudgeSeed[] = [
  {
    slug: 'is-bug',
    name: 'Is a bug report',
    question: 'Does this issue report something behaving incorrectly?',
    // A label with no valence: it is neither a pass nor a failure, so it scores nothing
    // and is absent from both the numerator and the denominator (ADR-0019).
    polarity: 'does_not_score',
    weight: null,
    required: false,
  },
  {
    slug: 'is-feature',
    name: 'Is a feature request',
    question: 'Does this issue ask for behaviour that does not exist yet?',
    polarity: 'does_not_score',
    weight: null,
    required: false,
  },
  {
    slug: 'is-question',
    name: 'Is a question',
    question: 'Is this issue asking how to do something, rather than reporting a problem?',
    polarity: 'does_not_score',
    weight: null,
    required: false,
  },
  {
    slug: 'needs-human',
    name: 'Needs a human',
    question: 'Does this issue need a maintainer to read it before any automated reply?',
    // The one real gate on the panel. Answering `true` FAILS, and it is required — a veto,
    // which is how `weighted_threshold` expresses that policy without a second code path.
    polarity: 'fails',
    weight: 1,
    required: true,
  },
]

const seed = async () => {
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

  for (const [index, judge] of JUDGES.entries()) {
    const judgeId = seedId('jud_', `SEEDJDG${index}`)
    const judgeVersionId = seedId('jdv_', `SEEDJDGV${index}`)
    await client`
      INSERT INTO judges (id, panel_id, slug, name)
      VALUES (${judgeId}, ${PANEL}, ${judge.slug}, ${judge.name})
      ON CONFLICT (id) DO NOTHING
    `
    await client`
      INSERT INTO judge_versions
        (id, judge_id, version, type, polarity, weight, required, question, model, model_pin)
      VALUES (
        ${judgeVersionId}, ${judgeId}, 1, 'llm', ${judge.polarity}::judge_polarity,
        ${judge.weight}, ${judge.required}, ${judge.question}, 'fake:deterministic',
        -- Every llm judge carries a pin, fake: ones included (ADR-0025), so the CHECK
        -- can be the clean mirror of the model/type rule. Real models arrive at P5.
        --
        -- Bound as an OBJECT, never JSON.stringify'd first. Bun's SQL driver serializes
        -- objects itself, so pre-stringifying sends a JSON string and the ::jsonb cast
        -- then stores a jsonb STRING rather than an object -- the same double-encoding
        -- that jsonb-encoding.test.ts exists to catch. Verified with jsonb_typeof.
        ${DEFAULT_FAKE_PIN}::jsonb
      )
      ON CONFLICT (id) DO NOTHING
    `
    // The membership row is what makes the panel version pin its judge set, and so what
    // makes its immutability mean anything.
    await client`
      INSERT INTO panel_version_judges (panel_version_id, judge_version_id)
      VALUES (${PANEL_VERSION}, ${judgeVersionId})
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

await seed()
await db.close()

// Rendered exactly once at creation is the RULE for real keys (ADR-0003); this one is
// printed on every seed because it is a fixed local credential, not a secret, and the
// README quotes it verbatim. Production key issuance shows the plaintext once and stores
// only the hash — which is why `api_keys` has no column that could hold it.
console.log(`seeded org ${ORG}`)
console.log(`  panel  ${PANEL} (issue-triage), live @ ${PANEL_VERSION}, threshold 0.5`)
console.log(`  judges ${JUDGES.map((judge) => judge.slug).join(', ')}`)
console.log(`  key    ${DEV_KEY_PLAINTEXT}`)
console.log(`  login  ${SEED_USER_EMAIL} / ${SEED_USER_PASSWORD} (the console)`)
