import type { JsonValue } from '@labelloop/contracts'
import { boolean, index, pgTable, real, text } from 'drizzle-orm/pg-core'
import { apiKeys } from './api-keys.ts'
import { createdAt, id, idCheck, jsonbColumn, timestampAt } from './columns.ts'
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
    id: id('tr_').primaryKey(),
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
    /**
     * **The four roles, in the caller's own shapes** (ADR-0073). We never generated any of
     * them — their agent did (ADR-0019).
     *
     * `output` is the final answer or proposal, the one thing judged; `input` is everything
     * that led to it. Both are nullable only because of the rows written BEFORE they existed
     * (ADR-0074): migration 0013 backfilled `output` from `artifact` for every one of those,
     * and left `input` NULL, because a pre-migration trace never recorded one and inventing it
     * from the old `context` would be a guess stored as a fact. Phase 5 makes `output` NOT
     * NULL; `input` stays nullable for the legacy rows for good.
     */
    input: jsonbColumn<JsonValue>('input'),
    output: jsonbColumn<JsonValue>('output'),
    /** Per-call facts the judges need (an account record). Backfilled from `context`. */
    reference: jsonbColumn<Record<string, JsonValue>>('reference'),
    /** Bookkeeping (a conversation id): for filtering and grouping, never shown to judges. */
    metadata: jsonbColumn<Record<string, string>>('metadata'),
    /**
     * RETIRED by ADR-0073, and still written (ADR-0074). Every new row dual-writes its
     * output here as text — a string verbatim, anything else as JSON — so reverting to code
     * that reads only this column still finds every trace readable. Nullable so that a later
     * contraction is the only change left; dropped with `context` once the new shape has been
     * lived with (the plan's phase 5).
     */
    artifact: text('artifact'),
    /** RETIRED by ADR-0073: new rows write NULL. Its values live on in `reference`. */
    context: jsonbColumn<Record<string, string>>('context'),
    /**
     * The panel decision, denormalised so the common read needs no fan-in.
     *
     * **Both are NULLABLE, and only for one reason** (ADR-0060): a COLLECTING panel — one
     * with no judges yet — captures the trace in full and convenes nobody, so there is no
     * verdict and no score. A score over zero judges is not 0, it is undefined, and storing
     * a 0 would put a number in the trace table that reads as a real result.
     *
     * Null here therefore means exactly "this panel had no judges when the call arrived",
     * and nothing else. A judged evaluation always writes both, including a partial one,
     * where `complete` is what says the score was computed over a smaller denominator.
     */
    passed: boolean('passed'),
    score: real('score'),
    /** False when a scoring judge did not run, so `score` is real but partial. */
    complete: boolean('complete').notNull(),
    /** Echoed from the panel version, so the decision is auditable from the row alone. */
    threshold: real('threshold').notNull(),
    /**
     * When the asynchronous follow-up for this evaluation ran — the `record-evaluation`
     * job, enqueued once the row above is committed.
     *
     * Nullable, and that is the useful part twice over. It is what makes the job
     * IDEMPOTENT without a check-then-act: the handler's write is
     * `SET recorded_at = now() WHERE id = ? AND recorded_at IS NULL`, so a re-delivery
     * updates zero rows and Postgres, not application code, is what makes the second
     * delivery a no-op. And it is what makes a DROPPED enqueue recoverable: an evaluation
     * whose follow-up never ran is a row with a null here, so the reconciliation sweep
     * that M2's metering needs is a query rather than an archaeology project.
     */
    recordedAt: timestampAt('recorded_at'),
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
