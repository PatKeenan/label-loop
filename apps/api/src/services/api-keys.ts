import { newId } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { sha256Hex } from '../middleware/api-key-auth.ts'
import type { Clock } from '../ports/clock.ts'
import { insertApiKey, revokeApiKey as revokeRow } from '../repositories/api-keys.ts'
import { recordAuditEvent } from '../repositories/audit-events.ts'

/**
 * Issuing and revoking API keys (ADR-0003) — the first write path `api_keys` has had outside
 * `scripts/seed.ts`, and the first writer `audit_events` has had at all (ADR-0051).
 *
 * It is a SERVICE rather than a route handler because it has two callers that share nothing
 * else: the console, behind a session and a role guard, and `scripts/mint-keys.ts`, which has
 * no session, no CORS and no HTTP at all (ADR-0058). Putting the minting here means the load
 * harness exercises the same code the console does, instead of a second implementation that
 * drifts — the seam is nearly free while this is being written and expensive to retrofit.
 */

/**
 * `llk_live_` for production traffic, `llk_test_` against a throwaway database
 * (CONVENTIONS.md "Keys & auth").
 *
 * Derived from the environment rather than chosen by the caller, because this product has no
 * test/live MODE the way a payments API does — there is one database and one set of panels.
 * The prefix is therefore a fact about where the key was minted, and letting a request pick
 * it would make it a claim instead. `scripts/seed.ts` mints `llk_test_` on the same
 * reasoning.
 */
const keyPrefix = (nodeEnv: string): string =>
  nodeEnv === 'production' ? 'llk_live_' : 'llk_test_'

/**
 * 32 random bytes, hex-encoded (CONVENTIONS.md). `crypto.getRandomValues` and not `Math.random`,
 * which is not a CSPRNG and would make every key in the system guessable from any other.
 */
const randomSecret = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')

export type IssuedApiKey = {
  id: string
  last4: string
  /**
   * **The only time this value exists anywhere.** It is not stored, not logged, and not
   * recoverable — only its SHA-256 is written — so a caller that loses it must issue another
   * key. The console shows it once and says so.
   */
  plaintext: string
}

export type IssueApiKeyInput = {
  db: Database
  clock: Clock
  nodeEnv: string
  orgId: string
  panelId: string
  name: string
  /** The signed-in user, or null when a script issued it (`authored.ts` allows both). */
  actorId: string | null
  /** The execution that caused it, so the event joins to its spans (ADR-0010). */
  requestId: string | null
}

/**
 * Mint a key, store its hash, and record that it happened — in ONE transaction.
 *
 * The transaction is the point rather than ceremony. A key row without its `api_key.issued`
 * event is a live credential with no provenance, and an event without its key is a record of
 * something that did not happen; both are worse outcomes than the request failing. The audit
 * log has no UPDATE, so neither could be repaired afterwards.
 *
 * The caller is trusted for `orgId` and NOT for `panelId`: the org comes from the session
 * middleware, while the panel arrives in a request body, so the route checks it belongs to
 * the org before calling this.
 */
export const issueApiKey = async ({
  db,
  clock,
  nodeEnv,
  orgId,
  panelId,
  name,
  actorId,
  requestId,
}: IssueApiKeyInput): Promise<IssuedApiKey> => {
  const plaintext = `${keyPrefix(nodeEnv)}${randomSecret()}`
  const id = newId('key_', clock.now())
  const last4 = plaintext.slice(-4)

  await db.transaction(async (tx) => {
    await insertApiKey(tx, {
      id,
      orgId,
      panelId,
      name,
      hash: sha256Hex(plaintext),
      last4,
      // The same value the audit row records as actor, so "who issued this key" has one
      // answer whether you ask the row or the log. Null when a script did it (ADR-0058).
      createdBy: actorId,
    })
    await recordAuditEvent(tx, {
      orgId,
      actorType: actorId === null ? 'system' : 'user',
      actorId,
      action: 'api_key.issued',
      subjectType: 'api_key',
      subjectId: id,
      // `last4` and the panel, never the plaintext or the hash. This table has no DELETE
      // (ADR-0051) and M8 adds export, so anything written here is permanent and leaves.
      data: { panel_id: panelId, name, last4 },
      requestId,
    })
  })

  return { id, last4, plaintext }
}

export type RevokeApiKeyInput = {
  db: Database
  clock: Clock
  orgId: string
  keyId: string
  actorId: string | null
  requestId: string | null
}

/**
 * Revoke a key, and record that it happened. Returns `false` when nothing was revoked —
 * because the key belongs to another org, does not exist, or was already revoked.
 *
 * **The three are not distinguished, and the route answers `NOT_FOUND` for all of them**
 * (ADR-0057's posture, applied to keys). Separating "already revoked" from "not yours" would
 * confirm that another tenant's key id exists.
 *
 * No audit row is written when nothing changed. An `api_key.revoked` event for a key that was
 * already revoked would be a permanent record of an act that did not occur, in the one table
 * that cannot correct itself.
 */
export const revokeApiKey = async ({
  db,
  clock,
  orgId,
  keyId,
  actorId,
  requestId,
}: RevokeApiKeyInput): Promise<boolean> => {
  return db.transaction(async (tx) => {
    const revoked = await revokeRow(tx, keyId, orgId, new Date(clock.now()))
    if (!revoked) return false

    await recordAuditEvent(tx, {
      orgId,
      actorType: actorId === null ? 'system' : 'user',
      actorId,
      action: 'api_key.revoked',
      subjectType: 'api_key',
      subjectId: keyId,
      data: null,
      requestId,
    })
    return true
  })
}
