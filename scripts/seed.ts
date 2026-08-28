#!/usr/bin/env bun
import { type IdPrefix, isId } from '@labelloop/contracts'
import { createDatabase } from '@labelloop/db'
import { requireEnv } from './env.ts'

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
        (id, judge_id, version, type, polarity, weight, required, question, model)
      VALUES (
        ${judgeVersionId}, ${judgeId}, 1, 'llm', ${judge.polarity}::judge_polarity,
        ${judge.weight}, ${judge.required}, ${judge.question}, 'fake:deterministic'
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
