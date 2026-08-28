import { afterAll, describe, expect, test } from 'bun:test'
import { idPattern, isId } from '@labelloop/contracts'
import { eq } from 'drizzle-orm'
import { createDatabase } from '../client.ts'
import { orgs } from './orgs.ts'
import { panels } from './panels.ts'

/**
 * Primary keys are filled in at insert, so callers do not pass one (`$defaultFn`).
 *
 * Asserted by inserting WITHOUT an id and reading back what the database holds, rather
 * than by checking the schema declares a default — a `$defaultFn` that produced the wrong
 * prefix, or that silently did not fire, would satisfy the weaker test and fail the CHECK
 * constraint at the first real write.
 */

const db = createDatabase({ url: process.env.DATABASE_URL ?? '', max: 2 })

const created: string[] = []

afterAll(async () => {
  for (const orgId of created) await db.delete(orgs).where(eq(orgs.id, orgId))
  await db.close()
})

describe('primary keys are generated at insert', () => {
  test('an org inserted with no id comes back with a valid org_ ULID', async () => {
    const [row] = await db
      .insert(orgs)
      .values({ slug: `generated-${Date.now()}`, name: 'No id supplied' })
      .returning()
    expect(row).toBeDefined()
    if (row === undefined) return
    created.push(row.id)
    expect(isId('org_', row.id)).toBe(true)
    expect(row.id).toMatch(idPattern('org_'))
  })

  test('each table gets ITS OWN prefix, not a shared one', async () => {
    /**
     * The mistake this guards is a copy-pasted table declaration keeping the previous
     * table's prefix. The CHECK constraint would reject it — but at the first write in
     * whichever environment reached that table first, which may be production.
     */
    const [org] = await db
      .insert(orgs)
      .values({ slug: `prefixes-${Date.now()}`, name: 'Prefix fixtures' })
      .returning()
    if (org === undefined) throw new Error('org insert returned nothing')
    created.push(org.id)

    const [panel] = await db
      .insert(panels)
      .values({ orgId: org.id, slug: 'generated', name: 'Generated' })
      .returning()
    expect(isId('org_', org.id)).toBe(true)
    expect(isId('pnl_', panel?.id)).toBe(true)
  })

  test('an explicit id is still accepted — the default is a default, not a mandate', async () => {
    /**
     * The property that made `$defaultFn` the right choice over a database-side default:
     * an evaluation wants to mint its `tr_` id up front and bind it to the logger before
     * the row exists. A `gen_random_uuid()` default would make that impossible.
     */
    // Crockford base32 omits I, L, O and U — the characters people misread — so the zero
    // in "CH0SEN" is deliberate rather than a typo.
    const chosen = 'org_00000000000000000000CH0SEN'
    const [row] = await db
      .insert(orgs)
      .values({ id: chosen, slug: `explicit-${Date.now()}`, name: 'Explicit id' })
      .returning()
    created.push(chosen)
    expect(row?.id).toBe(chosen)
  })

  test('two inserts get different ids, and they sort in insertion order', async () => {
    // ULIDs are time-ordered, which is what keeps `traces` appending to its index rather
    // than scattering page splits across it.
    const first = await db
      .insert(orgs)
      .values({ slug: `sort-a-${Date.now()}`, name: 'First' })
      .returning()
    const second = await db
      .insert(orgs)
      .values({ slug: `sort-b-${Date.now()}`, name: 'Second' })
      .returning()
    const a = first[0]?.id
    const b = second[0]?.id
    if (a === undefined || b === undefined) throw new Error('insert returned nothing')
    created.push(a, b)
    expect(a).not.toBe(b)
    expect(a < b).toBe(true)
  })
})
