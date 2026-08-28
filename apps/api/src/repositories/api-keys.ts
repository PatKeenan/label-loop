import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { eq } from 'drizzle-orm'

/**
 * Reads of `api_keys`. A repository rather than a query inside the middleware, so the
 * middleware is about *authorisation* and this file is about storage — and so the one
 * query on the hot path of every request is in a place someone would think to look at
 * when it needs an index.
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
