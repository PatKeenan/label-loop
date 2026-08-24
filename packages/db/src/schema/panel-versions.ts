import { sql } from 'drizzle-orm'
import { check, integer, pgTable, real, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { aggregationPolicy, createdAt, id, idCheck } from './columns.ts'
import { panels } from './panels.ts'

/**
 * An immutable panel configuration (ADR-0003). Editing a panel writes version n+1; it
 * never updates one of these rows, which is what makes "the panel improved" provable
 * rather than asserted — an agreement timeline plotted per version cannot silently span a
 * configuration change.
 *
 * Immutability is structural here: there is no mutable column to update. The `app` role
 * still holds UPDATE by default, because M0's single deliberate grant exception is
 * `audit_events` and widening that set is a decision, not an implementation detail.
 *
 * There is deliberately NO `current_version_id` pointer on `panels`. ADR-0003 defines an
 * edit as creating version n+1, so the live version is the highest one, and a pointer
 * would be a second source of truth for a fact the version number already carries (as
 * well as a circular foreign key). Pinning an older version is not a described feature;
 * when it becomes one, the pointer is the change that adds it.
 */
export const panelVersions = pgTable(
  'panel_versions',
  {
    id: id().primaryKey(),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    /** Monotonic per panel, starting at 1. The highest is the live one. */
    version: integer('version').notNull(),
    /**
     * The bar the weighted score must meet, 0–1. Echoed in every response so a decision
     * is auditable from the payload alone rather than requiring a config lookup.
     */
    threshold: real('threshold').notNull(),
    /** One policy at M0, and the seam a second would arrive through (ADR-0019). */
    aggregationPolicy: aggregationPolicy('aggregation_policy')
      .notNull()
      .default('weighted_threshold'),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('panel_versions', table.id, 'pnv_'),
    uniqueIndex('panel_versions_panel_version_key').on(table.panelId, table.version),
    check('panel_versions_version_positive', sql`${table.version} >= 1`),
    check(
      'panel_versions_threshold_range',
      sql`${table.threshold} >= 0 AND ${table.threshold} <= 1`,
    ),
  ],
)
