import { boolean, index, jsonb, pgTable, real, text } from 'drizzle-orm/pg-core'
import { apiKeys } from './api-keys.ts'
import { createdAt, id, idCheck } from './columns.ts'
import { orgs } from './orgs.ts'
import { panelVersions } from './panel-versions.ts'
import { panels } from './panels.ts'

/**
 * One stored panel evaluation — the `tr_` object the trace explorer addresses and SMEs
 * annotate, written on 100% of calls because we are the inference path for judge calls
 * (ADR-0001). Per-judge detail lives in `trace_verdicts`; this row is the panel-level
 * decision.
 */
export const traces = pgTable(
  'traces',
  {
    id: id().primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    /** The immutable configuration that produced this decision (ADR-0003). */
    panelVersionId: text('panel_version_id')
      .notNull()
      .references(() => panelVersions.id, { onDelete: 'restrict' }),
    /**
     * The key that authorised the call, and the column that makes metering decomposable.
     * Billing runs org → panel → judge → key: two external clients on one panel are two
     * separate bills, and "what does Client A owe for this panel" is unanswerable without
     * this. An aggregate cannot be decomposed after the fact, so it is cheap here and a
     * backfill against production traffic later.
     *
     * Nullable, and `set null` on delete, because a trace outlives the key that made it —
     * losing the whole evaluation record to a key's removal would be the worse failure.
     */
    apiKeyId: text('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
    /**
     * The W3C trace id of the HTTP execution that produced this row (ADR-0010). NOT this
     * row's own id: `request_id` covers all traffic and expires with the tracing backend's
     * retention, while `tr_` is permanent and exists only for evaluations. Storing both is
     * what lets a permanent business record join to its spans for as long as they last.
     */
    requestId: text('request_id').notNull(),
    /** The caller's artifact. We never generated it — their agent did (ADR-0019). */
    artifact: text('artifact').notNull(),
    /** Caller-supplied context. Their metadata, opaque to us. */
    context: jsonb('context'),
    /** The panel decision, denormalised so the common read needs no fan-in. */
    passed: boolean('passed').notNull(),
    score: real('score').notNull(),
    /** False when a scoring judge did not run, so `score` is real but partial. */
    complete: boolean('complete').notNull(),
    /** Echoed from the panel version, so the decision is auditable from the row alone. */
    threshold: real('threshold').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('traces', table.id, 'tr_'),
    // The trace explorer's default view, and the metering rollup's grouping.
    index('traces_org_created_idx').on(table.orgId, table.createdAt),
    index('traces_panel_created_idx').on(table.panelId, table.createdAt),
    // "Find the evaluation behind the request id a customer quoted to support."
    index('traces_request_id_idx').on(table.requestId),
  ],
)
