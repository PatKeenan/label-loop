import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdBy } from './authored.ts'
import { createdAt, id, idCheck, updatedAt } from './columns.ts'
import { panels } from './panels.ts'

/**
 * A judge: one failure category, one binary question (ADR-0019). Never one judge doing
 * several things — a judge asked to assess many criteria at once returns a verdict that
 * cannot be measured, debugged, attributed or paid against.
 *
 * As with panels, this row is only the stable identity. The question, the model, the
 * polarity and the weight all live on an immutable `judge_versions` row.
 */
export const judges = pgTable(
  'judges',
  {
    id: id('jud_').primaryKey(),
    panelId: text('panel_id')
      .notNull()
      .references(() => panels.id, { onDelete: 'cascade' }),
    /**
     * The stable handle — `is-p0`, `is-missing-repro`. This is the key in the response
     * (`judges["is-p0"]`) and the name a developer writes in their own code, so it is
     * load-bearing public surface rather than an internal convenience.
     */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Who authored this row. See `authored.ts` for why it is `user`. */
    createdBy: createdBy(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    idCheck('judges', table.id, 'jud_'),
    uniqueIndex('judges_panel_slug_key').on(table.panelId, table.slug),
  ],
)
