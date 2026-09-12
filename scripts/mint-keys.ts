#!/usr/bin/env bun
import { createDatabase } from '@labelloop/db'
import { systemClock } from '../apps/api/src/adapters/system-clock.ts'
import { panelBelongsToOrg } from '../apps/api/src/repositories/panels.ts'
import { issueApiKey } from '../apps/api/src/services/api-keys.ts'
import { envOr, requireEnv } from './env.ts'

/**
 * Mint N API keys for one panel, through the SAME service the console calls (ADR-0058).
 *
 * **Why this exists, and why it is a script rather than an endpoint.** `docs/BREAKING_POINT.md`
 * v0 reports a rate-limiter bound rather than a saturation point: the limiter is per-key at
 * 60/minute (ADR-0038), so one key cannot exceed roughly one served request per second and the
 * instance's knee was unreachable rather than unmeasured. §8 ranks "mint many keys" first among
 * what would make v1 worth reading. A k6 script cannot sign in — that would couple the load
 * harness to session auth, CORS and cookie handling — so the door it needs is this one.
 *
 * It calls `issueApiKey` rather than writing SQL, which is the whole point: the keys a load run
 * uses are minted by the code path the product uses, so a k6 run is exercising real keys with
 * real audit rows rather than fixtures that drift from what the console produces.
 *
 * **Producing BREAKING_POINT v1 is NOT in scope** — this only makes the number reachable.
 *
 * Usage:
 *   MINT_PANEL_ID=pnl_… MINT_COUNT=20 bun run scripts/mint-keys.ts
 *
 * Every plaintext is printed ONCE, to stdout, and is unrecoverable afterwards — so redirect it
 * to a file k6 can read, and treat that file as the secret it is:
 *
 *   MINT_PANEL_ID=pnl_… bun run scripts/mint-keys.ts > /tmp/keys.txt
 */

const db = createDatabase({ url: requireEnv('DATABASE_URL'), max: 4 })

const PANEL_ID = requireEnv('MINT_PANEL_ID')
const ORG_ID = requireEnv('MINT_ORG_ID')
const NAME_PREFIX = envOr('MINT_NAME_PREFIX', 'load')

/** Bounded, because this writes credentials and a typo in a shell loop is a real hazard. */
const MAX_COUNT = 500

const count = (() => {
  const parsed = Number(envOr('MINT_COUNT', '10'))
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_COUNT) {
    console.error(`MINT_COUNT must be an integer between 1 and ${MAX_COUNT}; got "${parsed}".`)
    process.exit(1)
  }
  return parsed
})()

/**
 * The org is checked against the panel rather than trusted, even though the only caller is an
 * operator with a database URL. It costs one query and it turns a mistyped id into a refusal
 * instead of a set of keys scoped to the wrong tenant's panel — which would authenticate
 * against their traffic and be indistinguishable from an attack in the audit log.
 */
if (!(await panelBelongsToOrg(db, PANEL_ID, ORG_ID))) {
  console.error(
    `Panel ${PANEL_ID} does not belong to org ${ORG_ID} (or does not exist). Nothing minted.`,
  )
  await db.close()
  process.exit(1)
}

// `actorId: null` — a script is not a person, and `authored.ts` allows exactly that: the
// audit row records `actor_type: 'system'` rather than attributing this to whoever ran it.
// `requestId: null` for the same reason: there is no HTTP execution to join to.
for (let i = 1; i <= count; i++) {
  const issued = await issueApiKey({
    db,
    clock: systemClock,
    nodeEnv: envOr('NODE_ENV', 'development'),
    orgId: ORG_ID,
    panelId: PANEL_ID,
    name: `${NAME_PREFIX}-${String(i).padStart(3, '0')}`,
    actorId: null,
    requestId: null,
  })
  // stdout is the deliverable: one key per line, so `> keys.txt` is a usable k6 input.
  console.log(issued.plaintext)
}

console.error(`Minted ${count} key(s) for panel ${PANEL_ID}. Each plaintext was printed once.`)
await db.close()
