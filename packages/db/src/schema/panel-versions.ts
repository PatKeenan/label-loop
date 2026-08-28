import { sql } from 'drizzle-orm'
import { check, integer, pgTable, real, text, unique, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdBy } from './authored.ts'
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
 * Which version is LIVE is a pointer on `panels`, not "the highest number here". Version
 * order is history; activation is a separate fact. Without the pointer there is no way to
 * roll back — reverting would mean copying v1's configuration into a new v3 — and no way
 * to prepare a version without it judging traffic the instant it is inserted.
 *
 * The `(panel_id, id)` unique constraint below exists only to be the target of that
 * pointer's composite foreign key, which is what stops a panel activating a version
 * belonging to a DIFFERENT panel. A plain reference to `id` alone would allow exactly
 * that, and it would look correct.
 */
export const panelVersions = pgTable(
  'panel_versions',
  {
    id: id('pnv_').primaryKey(),
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
    /** Who authored this row. See `authored.ts` for why it is `user`. */
    createdBy: createdBy(),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('panel_versions', table.id, 'pnv_'),
    uniqueIndex('panel_versions_panel_version_key').on(table.panelId, table.version),
    // Not redundant with the primary key: a composite foreign key needs a unique
    // constraint on exactly the columns it references.
    unique('panel_versions_panel_id_id_key').on(table.panelId, table.id),
    check('panel_versions_version_positive', sql`${table.version} >= 1`),
    check(
      'panel_versions_threshold_range',
      sql`${table.threshold} >= 0 AND ${table.threshold} <= 1`,
    ),
  ],
)
