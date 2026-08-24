import { pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { judgeVersions } from './judge-versions.ts'
import { panelVersions } from './panel-versions.ts'

/**
 * The judge set a panel version pins.
 *
 * This table is what makes `pnv_` immutability mean anything. The published contract says
 * a panel version pins "weights, threshold and judge set" (ADR-0019), and the threshold
 * lives on `panel_versions` while the weights live on `judge_versions` — so without a
 * pinned membership row, a `pnv_` would fix the bar while the judges underneath it moved,
 * and a score timeline would silently span a configuration change anyway.
 *
 * The consequence is deliberate: changing any judge's configuration creates a new `jdv_`,
 * which creates a new `pnv_`. Versions are cheap; an unfalsifiable "it improved" is not.
 */
export const panelVersionJudges = pgTable(
  'panel_version_judges',
  {
    panelVersionId: text('panel_version_id')
      .notNull()
      .references(() => panelVersions.id, { onDelete: 'cascade' }),
    judgeVersionId: text('judge_version_id')
      .notNull()
      .references(() => judgeVersions.id, { onDelete: 'restrict' }),
  },
  (table) => [primaryKey({ columns: [table.panelVersionId, table.judgeVersionId] })],
)
