import { newId } from '@labelloop/contracts'
import { schema } from '@labelloop/db'
import type { Executor } from './executor.ts'

/**
 * Writing the append-only audit log — the first application code to do so since the table
 * shipped at M0 (ADR-0051).
 *
 * **There is one function here and it INSERTS.** That is not minimalism, it is the shape the
 * table's guarantee requires: the app role holds `INSERT` and `SELECT` and nothing else, by
 * Postgres grant rather than by application convention, and `packages/db/src/audit-events.test.ts`
 * proves its `UPDATE` and `DELETE` are rejected. A repository offering an update would be
 * offering a call that cannot succeed. When M8 builds the viewer it adds a read here; it will
 * never add a write that is not an append.
 *
 * The table's own comment predicted this: *"the events arrive with the features that generate
 * them, starting with key issuance"*. It said M1, and M1 issued its key from the seed script
 * instead, so this is the first time the grant is exercised by anything but a test.
 */

/**
 * Who did it. Free text in the column because M8 owns the vocabulary, narrowed to a union
 * here because M4 knows exactly which three it can mean and a typo would be invisible in a
 * log nobody reads until it matters.
 */
export type AuditActorType = 'user' | 'api_key' | 'system'

export type AuditEvent = {
  /** Null for platform-level events that belong to no tenant. */
  orgId: string | null
  actorType: AuditActorType
  /** The better-auth user id for `user`, a `key_` for `api_key`, null for `system`. */
  actorId: string | null
  /** Dotted and past tense: `api_key.issued`. It already happened; this is not a command. */
  action: string
  subjectType: string | null
  subjectId: string | null
  /** Per-action detail. NEVER a secret — see the warning below. */
  data: Record<string, unknown> | null
  /** The execution that caused it, so an event joins to its spans (ADR-0010). */
  requestId: string | null
}

/**
 * Append one event.
 *
 * **Nothing sensitive goes in `data`.** The audit log is the one table designed to outlive
 * everything and to be read by people who were not there — it has no UPDATE and no DELETE, so
 * a secret written here cannot be taken back out, and M8 adds export on top. Key plaintext,
 * password material and artifact bodies are all excluded by the same rule that keeps them out
 * of log lines (CONVENTIONS.md "Logging"), and here it is permanent rather than merely
 * retained.
 */
export const recordAuditEvent = async (db: Executor, event: AuditEvent): Promise<string> => {
  const id = newId('aud_')
  await db.insert(schema.auditEvents).values({ id, ...event })
  return id
}
