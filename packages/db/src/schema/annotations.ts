import { sql } from 'drizzle-orm'
import { check, index, pgEnum, pgTable, text } from 'drizzle-orm/pg-core'
import { annotationSets } from './annotation-sets.ts'
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
     * WHICH SET this answer was given against (ADR-0079). RESTRICT, as authorship is: a set
     * whose answers exist is a pass that happened, and it cannot be deleted out from under
     * them. The org cascade is the only thing that removes either.
     *
     * **NULLABLE only for the rows written before phase 7.** Annotation used to run against a
     * whole panel, so those answers belong to no set and never will; backfilling them into an
     * invented one would be a claim nobody made. Every row written from here carries it.
     */
    annotationSetId: text('annotation_set_id').references(() => annotationSets.id, {
      onDelete: 'restrict',
    }),
    /**
     * WHICH PICKER served this item — copied from the membership row that put the trace in the
     * set (`manual`, `latest_n`, `earliest_n`, `random_n`). It was the constant `'random'`
     * through M5 phase 6, when the queue WAS the sampler; now the set's picker is the answer,
     * and "which strategy found the failures" stays a question the rows can answer.
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
    // The queue's pool question, per person: "which of this set's traces have I answered?"
    index('annotations_set_annotator_idx').on(table.annotationSetId, table.annotatorId),
  ],
)
