import { afterAll, describe, expect, test } from 'bun:test'
import { idPattern, isId, newId } from '@labelloop/contracts'
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

  /**
   * What a ULID actually orders by, and what it does not.
   *
   * The first 10 characters are a millisecond timestamp and the remaining 16 are random.
   * So ids sort by TIME at millisecond granularity — and within a single millisecond the
   * random suffix decides, which is a coin flip, because `newId` draws a fresh suffix per
   * call rather than incrementing the previous one (the ULID spec's optional monotonic
   * mode, which this project does not use).
   *
   * The original version of this test asserted `a < b` for two back-to-back inserts and
   * was therefore a 50/50 gamble on whether two round-trips straddled a millisecond
   * boundary. It passed on a developer machine and failed on a faster CI runner.
   *
   * Splitting it in two is not a weakening. The property the design rests on — `traces`
   * appending to its index rather than scattering page splits across it, per the comment
   * on `id()` in `columns.ts` — is about a stream of inserts over time, and is untouched
   * by how two ids minted in the same tick happen to compare.
   */
  test('ids sort in insertion order across time — the property the index relies on', async () => {
    const first = await db
      .insert(orgs)
      .values({ slug: `sort-a-${Date.now()}`, name: 'First' })
      .returning()
    // Cross the millisecond boundary deliberately, because that is the granularity the
    // guarantee is stated at. Without this the assertion below is a coin toss.
    await Bun.sleep(2)
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

  test('two ids minted in the SAME millisecond are distinct, and are not ordered', async () => {
    // Uniqueness is the guarantee here, and it comes from the 16 random characters — 80
    // bits — not from the clock. Ordering is explicitly NOT claimed: asserting it is what
    // made this file fail intermittently in CI.
    const now = Date.now()
    const a = newId('org_', now)
    const b = newId('org_', now)
    expect(a).not.toBe(b)
    expect(a.slice(0, 'org_'.length + 10)).toBe(b.slice(0, 'org_'.length + 10))
  })
})
