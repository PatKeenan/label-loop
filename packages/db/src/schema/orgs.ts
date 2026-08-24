import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdAt, id, idCheck, updatedAt } from './columns.ts'

/**
 * The tenant. Everything billable, ownable or annotatable hangs off an org, including at
 * M0 where there is exactly one of them and no UI to make a second.
 *
 * It exists this early because the alternative — adding tenancy once there is data — means
 * backfilling an `org_id` onto every table and re-deriving which rows belong to whom from
 * whatever incidental evidence survived.
 */
export const orgs = pgTable(
  'orgs',
  {
    id: id().primaryKey(),
    /** URL-safe handle. Stable, and the thing a console route is keyed by. */
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [idCheck('orgs', table.id, 'org_'), uniqueIndex('orgs_slug_key').on(table.slug)],
)
