import type { Database } from '@labelloop/db'

/**
 * Whatever a repository function runs its statement on: the pool handle, or a transaction
 * opened on it.
 *
 * It exists because of one rule the audit log introduces (ADR-0051): **an audit row and the
 * thing it describes are written together or not at all.** A key issued without its
 * `api_key.issued` event is a credential with no provenance, and an event without its key is
 * a record of something that did not happen. Both are worse than failing the request, so the
 * service opens a transaction and hands the SAME handle to both repositories — which is only
 * possible if they accept one.
 *
 * Derived from Drizzle's own callback parameter rather than written out, so it cannot drift
 * from the handle `db.transaction()` actually supplies.
 */
export type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0]
