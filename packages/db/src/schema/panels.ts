import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, id, idCheck, updatedAt } from './columns.ts'
import { orgs } from './orgs.ts'

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idCheck('panels', table.id, 'pnl_'),
    uniqueIndex('panels_org_slug_key').on(table.orgId, table.slug),
  ],
)
