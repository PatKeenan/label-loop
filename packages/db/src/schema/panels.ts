import type { PgTableExtraConfigValue } from 'drizzle-orm/pg-core'
import { foreignKey, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdBy } from './authored.ts'
import { createdAt, id, idCheck, updatedAt } from './columns.ts'
import { orgs } from './orgs.ts'
import { panelVersions } from './panel-versions.ts'

/**
 * A panel: the customer-facing object, a named set of judges convened over one artifact
 * (ADR-0019). This row is the stable identity — the name a key is scoped to and the id in
 * `POST /v1/panels/{panel_id}/evaluate`. Everything configurable about it lives on an
 * immutable `panel_versions` row instead, which is why there is so little here.
 */
export const panels = pgTable(
  'panels',
  {
    id: id('pnl_').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** Stable handle, unique within the org. Survives renames; `name` does not. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /**
     * The version currently serving traffic. Activation is a POINTER, not "the highest
     * version number" — those are different facts, and conflating them makes rollback
     * impossible (reverting would mean copying an old config forward into a new version)
     * and makes a draft impossible (a new version would go live the instant it is
     * inserted). Moving this is the activation gesture, and M8's audit log is what has to
     * record the move, since a pointer that slides leaves no trace on its own.
     *
     * Nullable: a panel exists for a moment before its first version does.
     */
    currentVersionId: text('current_version_id'),
    /** Who authored this row. See `authored.ts` for why it is `user`. */
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  // The return type is annotated rather than inferred. `panels` references
  // `panel_versions` and `panel_versions` references `panels`, so leaving it to inference
  // makes TypeScript walk a cycle and give up with TS7024 — an error that surfaces in
  // apps/api rather than here, which is a confusing place to meet it.
  (table): PgTableExtraConfigValue[] => [
    idCheck('panels', table.id, 'pnl_'),
    uniqueIndex('panels_org_slug_key').on(table.orgId, table.slug),
    // Composite on purpose. Referencing `panel_versions.id` alone would let a panel
    // activate another panel's version — accepted by the database, wrong in every other
    // sense. Carrying `id` into the key makes the version prove it belongs here. A NULL
    // pointer is still allowed, because a composite foreign key with any NULL column is
    // not enforced under the default MATCH SIMPLE.
    foreignKey({
      name: 'panels_current_version_fk',
      columns: [table.id, table.currentVersionId],
      foreignColumns: [panelVersions.panelId, panelVersions.id],
    }),
  ],
)
