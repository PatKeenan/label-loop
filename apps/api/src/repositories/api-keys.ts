import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { and, desc, eq } from 'drizzle-orm'
import type { Executor } from './executor.ts'

/**
 * `api_keys`. A repository rather than a query inside the middleware, so the middleware is
 * about *authorisation* and this file is about storage — and so the one query on the hot
 * path of every request is in a place someone would think to look at when it needs an index.
 *
 * M4 adds the write half. Until now the only writer was `scripts/seed.ts`, going straight to
 * SQL, which is why `docs/BREAKING_POINT.md` reports a limiter bound rather than a saturation
 * point: with one key and a 60/minute limit the instance's knee was unreachable rather than
 * unmeasured (ADR-0058).
 */

export type StoredApiKey = {
  id: string
  orgId: string
  panelId: string
  status: 'active' | 'revoked'
}

/**
 * Look a key up by the SHA-256 of its plaintext. The hash is what is stored and what is
 * indexed (`api_keys_hash_key`), so this is a unique-index hit rather than a scan —
 * which matters, because it happens once per request on the busiest endpoint we have.
 *
 * Revoked keys are RETURNED, not filtered out. Revocation is a status flip precisely so
 * the row survives, and a caller that presents a revoked key is a different event from
 * one presenting an unknown key — same 401 to them, distinguishable to us.
 */
export const findApiKeyByHash = async (
  db: Database,
  hash: string,
): Promise<StoredApiKey | undefined> => {
  const row = await db.query.apiKeys.findFirst({
    where: eq(schema.apiKeys.hash, hash),
    columns: { id: true, orgId: true, panelId: true, status: true },
  })
  return row
}

/** A new key's row. `status` and the timestamps take their database defaults. */
export type NewApiKey = {
  id: string
  orgId: string
  panelId: string
  name: string
  /** SHA-256 of the plaintext, lowercase hex. The plaintext is never stored. */
  hash: string
  last4: string
  /** The user who issued it, or null when a script did (`authored.ts`). */
  createdBy: string | null
}

export const insertApiKey = async (db: Executor, key: NewApiKey): Promise<void> => {
  await db.insert(schema.apiKeys).values(key)
}

/**
 * One row of the console's key list. **No `hash`**, deliberately: it is not a secret the way
 * the plaintext is, but it is the lookup value on the hot path, and a list endpoint is not
 * the place to hand out a column whose only use is authentication.
 */
export type ApiKeyListItem = {
  id: string
  panelId: string
  name: string
  last4: string
  status: 'active' | 'revoked'
  revokedAt: Date | null
  createdAt: Date
}

/**
 * Every key for ONE org, newest first — revoked ones included.
 *
 * `orgId` is a required parameter rather than an optional filter, exactly as `listTraces`
 * has it: there is no way to call this that reads across tenants, so the rule is enforced by
 * the signature instead of by remembering a `where`.
 *
 * Revoked rows are listed because hiding them would make the console disagree with the audit
 * log about what exists — and because "this key was revoked on Tuesday" is the answer someone
 * is looking for when they come to this screen.
 */
export const listApiKeys = async (db: Executor, orgId: string): Promise<ApiKeyListItem[]> =>
  db
    .select({
      id: schema.apiKeys.id,
      panelId: schema.apiKeys.panelId,
      name: schema.apiKeys.name,
      last4: schema.apiKeys.last4,
      status: schema.apiKeys.status,
      revokedAt: schema.apiKeys.revokedAt,
      createdAt: schema.apiKeys.createdAt,
    })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.orgId, orgId))
    .orderBy(desc(schema.apiKeys.createdAt))

/**
 * Revoke a key: a status flip, never a delete (CONVENTIONS.md "Keys & auth"). Returns whether
 * THIS call is the one that revoked it.
 *
 * Three things are load-bearing in the `where`, and each fails differently:
 *
 * - `org_id` is matched rather than trusted, so a key id belonging to another tenant updates
 *   nothing. The caller's org comes from the session and never from the request body.
 * - `status = 'active'` makes a second revocation a no-op that POSTGRES decided, not one the
 *   handler decided after a read — which is the version with a race in it, and the same
 *   mechanism `markTraceRecorded` uses for job redelivery.
 * - The row is UPDATEd, never removed: the audit trail and every `traces.api_key_id` pointing
 *   at it have to survive. `api-key-auth.ts` still finds it and refuses it on `status`.
 */
export const revokeApiKey = async (
  db: Executor,
  id: string,
  orgId: string,
  revokedAt: Date,
): Promise<boolean> => {
  const rows = await db
    .update(schema.apiKeys)
    .set({ status: 'revoked', revokedAt, updatedAt: revokedAt })
    .where(
      and(
        eq(schema.apiKeys.id, id),
        eq(schema.apiKeys.orgId, orgId),
        eq(schema.apiKeys.status, 'active'),
      ),
    )
    .returning({ id: schema.apiKeys.id })
  return rows.length > 0
}
