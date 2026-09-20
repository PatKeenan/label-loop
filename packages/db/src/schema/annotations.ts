import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'
import { createdAt, id, idCheck } from './columns.ts'
import { orgs } from './orgs.ts'
import { panelVersions } from './panel-versions.ts'
import { panels } from './panels.ts'
import { traces } from './traces.ts'

/**
 * ONE PERSON'S ANSWER ABOUT ONE TRACE — the open-coding record M6's taxonomy is built from
 * (ADR-0066).
 *
 * **Append-only by GRANT, like `audit_events`**: the app role holds INSERT and SELECT on this
 * table and nothing else, enforced by Postgres and proven by a test, not by trusting that no
 * code path updates it. A changed mind is a NEW ROW, which is also why many rows per trace are
 * permitted: the sequence is the evidence, and an annotation edited in place would destroy the
 * disagreement M6 exists to measure.
 *
 * **`annotator_id` is `RESTRICT`, deliberately.** Contribution attaches to the PERSON and
 * outlives their membership (PRODUCT.md §10: royalties persist after a contributor leaves), so
 * a user who has annotated cannot be deleted out from under the record. The org cascade is the
 * only thing that removes these rows, with everything else that org owned.
 */
export const ANNOTATION_OUTCOMES = ['acceptable', 'not_acceptable', 'skipped'] as const

export const annotationOutcome = pgEnum('annotation_outcome', ANNOTATION_OUTCOMES)

/** The cap the note is written against (ADR-0066). Short notes cluster; essays do not. */
export const ANNOTATION_NOTE_MAX_LENGTH = 280

export const annotations = pgTable(
  'annotations',
  {
    id: id('ann_').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    traceId: text('trace_id')
      .notNull()
      .references(() => traces.id, { onDelete: 'cascade' }),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    /**
     * COPIED FROM THE TRACE at write time, not resolved later (ADR-0003). The panel the
     * annotator was reading is the panel this answer is about; a version authored afterwards
     * must not be able to rewrite what a past annotation was judging.
     */
    panelVersionId: text('panel_version_id')
      .notNull()
      .references(() => panelVersions.id, { onDelete: 'restrict' }),
    /** A better-auth id (ADR-0008). RESTRICT — see the note above. */
    annotatorId: text('annotator_id')
      .notNull()
      .references(() => user.id, { onDelete: 'restrict' }),
    outcome: annotationOutcome('outcome').notNull(),
    /**
     * Why, when the answer is `not_acceptable`. Required there and forbidden on a skip, by
     * CHECK rather than by convention: the note is the expensive signal — it is what axial
     * coding clusters into the failure taxonomy — and `acceptable` may carry one or not.
     */
    note: text('note'),
    /**
     * WHICH SAMPLER served this item: `random` at M5, and recorded on every row from the first
     * one. M6 adds low-confidence, disagreement and honeypot sampling, and "which strategy
     * found the failures" is unanswerable retroactively if the column arrives with them.
     */
    sampler: text('sampler').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('annotations', table.id, 'ann_'),
    check(
      'annotations_note_rules',
      sql`(${table.outcome} = 'not_acceptable' AND ${table.note} IS NOT NULL AND length(btrim(${table.note})) > 0)
          OR (${table.outcome} = 'acceptable')
          OR (${table.outcome} = 'skipped' AND ${table.note} IS NULL)`,
    ),
    check(
      'annotations_note_length',
      sql.raw(`"annotations"."note" IS NULL OR length("annotations"."note") <= 280`),
    ),
    // The queue's question — "has anybody answered this trace?" — asked once per item served.
    index('annotations_trace_idx').on(table.traceId),
    // "What has this person already seen here", which is what keeps a skip from coming back.
    index('annotations_panel_annotator_idx').on(table.panelId, table.annotatorId),
    // M6 reads a panel's annotations in order to cluster them.
    index('annotations_panel_created_idx').on(table.panelId, table.createdAt),
  ],
)
