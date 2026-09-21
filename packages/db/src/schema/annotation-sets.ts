import { ANNOTATION_SET_STRATEGIES } from '@labelloop/contracts'
import { sql } from 'drizzle-orm'
import { boolean, index, pgEnum, pgTable, primaryKey, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, id, idCheck, timestampAt } from './columns.ts'
import { orgs } from './orgs.ts'
import { panels } from './panels.ts'
import { traces } from './traces.ts'

/**
 * A CURATED, SNAPSHOTTED SELECTION OF ONE PANEL'S TRACES, assigned to people (ADR-0079).
 *
 * Three tables, and the split is the design: the set is a name and a lifecycle, its TRACES are
 * a snapshot that only grows, and its ANNOTATORS are assignments that are stamped rather than
 * deleted. Neither join table has an id of its own (CONVENTIONS "Id prefixes"): a surrogate key
 * on a join table is an id nothing ever quotes.
 */

/**
 * Which picker resolved a membership row (ADR-0080). The list comes from `@labelloop/contracts`
 * so a strategy cannot exist in the database that the request schema will not accept.
 */
export const annotationSetStrategy = pgEnum('annotation_set_strategy', ANNOTATION_SET_STRATEGIES)

/**
 * The set itself.
 *
 * **There is no `completed_at`, and that is the decision** (ADR-0086). Done is DERIVED — every
 * currently assigned annotator has answered every trace — because a stored flag would go on
 * saying "done" the moment a third annotator is assigned to a finished set, when the set
 * genuinely is not done any more. `archived_at` is the only lifecycle column here and it
 * records a PERSON's act: putting a finished, or abandoned, pass away.
 *
 * **No membership column and no cached count either.** Both are derivable, and a count cached
 * beside an append-only join table goes wrong silently.
 */
export const annotationSets = pgTable(
  'annotation_sets',
  {
    id: id('aset_').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** A set belongs to ONE panel. Sets spanning panels are explicitly not being built. */
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** RESTRICT, as authorship is everywhere here: who decided this was worth an afternoon. */
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /**
     * Stamped by a person, never by the system. Archiving does not change whether the set is
     * done: a half-finished pass can be abandoned and a finished one can be left on the list.
     */
    archivedAt: timestampAt('archived_at'),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('annotation_sets', table.id, 'aset_'),
    // Case-insensitively unique within its panel: "Refunds" and "refunds" on one panel are two
    // names for one pass, and the list is read by eye.
    uniqueIndex('annotation_sets_panel_name_key').on(table.panelId, sql`lower(${table.name})`),
    index('annotation_sets_panel_idx').on(table.panelId),
  ],
)

/**
 * WHO IS ASSIGNED, and which of them settles a disagreement (ADR-0081).
 *
 * Assignment is what makes work exist — an annotator with nothing assigned has nothing to do
 * (ADR-0079) — and it is also an ACCESS GRANT: it lets somebody read those traces' `input`,
 * `output` and `reference` through the annotate queue, in a panel they can otherwise reach
 * nothing of. That is why the write is `annotation: ['curate']` and why its audit event matters.
 *
 * **Unassigning is a stamp, never a delete** (ADR-0086, open question 3). The row stays, their
 * answers stay, and the set simply stops waiting on them — which is why "done" reads
 * `unassigned_at IS NULL` rather than every row here.
 */
export const annotationSetAnnotators = pgTable(
  'annotation_set_annotators',
  {
    annotationSetId: text('annotation_set_id')
      .notNull()
      .references(() => annotationSets.id, { onDelete: 'cascade' }),
    /** A better-auth id (ADR-0008). RESTRICT, as `annotations.annotator_id` is. */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    /**
     * Where answers differ, this person's is the one that counts — a rule for READING the rows,
     * not a workflow (ADR-0081). Changing who holds it re-reads every past disagreement in the
     * set, which is inherent to "a disagreement is two rows and a rule for reading them".
     */
    isDictator: boolean('is_dictator').notNull().default(false),
    assignedBy: text('assigned_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    assignedAt: timestampAt('assigned_at').notNull().defaultNow(),
    unassignedAt: timestampAt('unassigned_at'),
  },
  (table) => [
    primaryKey({ columns: [table.annotationSetId, table.userId] }),
    /**
     * ONE DICTATOR PER SET, enforced by the database rather than by the service that writes it.
     * Partial, over the CURRENTLY assigned: an unassigned former dictator's row keeps
     * `is_dictator` as the record of what they were, and must not block naming a new one.
     */
    uniqueIndex('annotation_set_one_dictator_key')
      .on(table.annotationSetId)
      .where(sql`${table.isDictator} AND ${table.unassignedAt} IS NULL`),
    // "Which sets is this person working?" — the annotator's own list, asked every visit.
    index('annotation_set_annotators_user_idx').on(table.userId),
  ],
)

/**
 * THE SNAPSHOT: which traces the set holds (ADR-0080).
 *
 * **Append-only by GRANT**, the treatment `audit_events` and `annotations` get. A picker
 * resolves ONCE and writes rows; it is never a query that re-evaluates, because what a past
 * annotation pass covered must stay reconstructible (ADR-0003) and a re-evaluating query
 * destroys exactly that. A set grows only by an explicit top-up, which runs a picker again and
 * appends — so rows only ever arrive, and "what the set held when this annotation happened"
 * stays a query rather than a lost fact.
 *
 * The trace is JOINED, never copied. `strategy` and `added_at` are on the row because the
 * question is about this membership rather than about the trace or the set.
 */
export const annotationSetTraces = pgTable(
  'annotation_set_traces',
  {
    annotationSetId: text('annotation_set_id')
      .notNull()
      .references(() => annotationSets.id, { onDelete: 'cascade' }),
    traceId: text('trace_id')
      .notNull()
      .references(() => traces.id, { onDelete: 'cascade' }),
    /** Which picker put this row here — copied onto every annotation the queue produces. */
    strategy: annotationSetStrategy('strategy').notNull(),
    addedAt: timestampAt('added_at').notNull().defaultNow(),
    addedBy: text('added_by')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
  },
  (table) => [
    primaryKey({ columns: [table.annotationSetId, table.traceId] }),
    // The queue's pool, and the staff read's grid: a set's traces in the order they arrived.
    index('annotation_set_traces_set_added_idx').on(table.annotationSetId, table.addedAt),
  ],
)
