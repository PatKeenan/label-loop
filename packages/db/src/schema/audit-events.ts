import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt, id, idCheck } from './columns.ts'
import { orgs } from './orgs.ts'

/**
 * The append-only audit log.
 *
 * It ships EMPTY at M0. Nothing in the application writes to it yet — the events arrive
 * with the features that generate them, starting with key issuance at M1, and the console
 * viewer, diffing, retention and export are M8. What ships now is the *guarantee*: the app
 * role holds INSERT and SELECT and nothing else, enforced by Postgres grants rather than
 * by application code, and proven by a test asserting that the app role's UPDATE and
 * DELETE are rejected.
 *
 * That is the whole point of creating the table this early. "Nobody edited the audit log"
 * backed by a grant and a test is a different claim from the same sentence backed by a
 * promise that no code path does it — and the grant has to exist before there is data to
 * protect, not after.
 *
 * Note the absence of `updated_at`. A column for recording that an append-only row changed
 * would be a contradiction in the schema itself.
 */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: id().primaryKey(),
    /** Nullable: platform-level events belong to no tenant. */
    orgId: text('org_id').references(() => orgs.id, { onDelete: 'set null' }),
    /** `user` | `api_key` | `system` — free text, because M8 defines the vocabulary. */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    /** `api_key.issued`, `panel_version.created`. Dotted, past tense: it already happened. */
    action: text('action').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    /** Before/after detail. Shape is per-action and deliberately not constrained yet. */
    data: jsonb('data'),
    /** Ties the event to the execution that caused it, and so to its spans (ADR-0010). */
    requestId: text('request_id'),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('audit_events', table.id, 'aud_'),
    index('audit_events_org_created_idx').on(table.orgId, table.createdAt),
    index('audit_events_subject_idx').on(table.subjectType, table.subjectId),
  ],
)
