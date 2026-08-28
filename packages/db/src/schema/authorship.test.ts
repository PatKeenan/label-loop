import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { and, eq } from 'drizzle-orm'
import { createDatabase } from '../client.ts'
import { user } from './auth.ts'
import { orgMembers } from './org-members.ts'
import { orgs } from './orgs.ts'
import { panels } from './panels.ts'

/**
 * Authorship survives the author leaving, and the database is what makes that true.
 *
 * The product decision behind these assertions (2026-08-24): a contributor keeps earning
 * from a judge that is still in use after they leave the org. That makes `created_by`
 * evidence the contribution ledger pays against rather than a display field — so the
 * interesting cases are not "can we store it" but "what happens when someone leaves",
 * and "what happens when someone tries to delete them".
 */

const db = createDatabase({ url: process.env.DATABASE_URL ?? '', max: 2 })

const orgId = newId('org_')
const userId = `authorship-test-${newId('org_')}`

beforeAll(async () => {
  await db.insert(orgs).values({ id: orgId, slug: orgId, name: 'Authorship fixtures' })
  await db
    .insert(user)
    .values({ id: userId, name: 'Departing Author', email: `${userId}@example.test` })
  await db.insert(orgMembers).values({ orgId, userId, role: 'engineer' })
})

afterAll(async () => {
  await db.delete(orgs).where(eq(orgs.id, orgId))
  await db.delete(user).where(eq(user.id, userId))
  await db.close()
})

/**
 * Drizzle wraps a driver failure in a `DrizzleQueryError` whose message is the SQL, so the
 * Postgres error code lives on `cause`. Asserting on the code rather than the message
 * matters here: "it threw" would also pass if the statement failed for a typo, and this
 * test's whole claim is about WHICH constraint stopped it.
 */
const errnoOf = (error: unknown): string | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ('errno' in current) return String((current as { errno: unknown }).errno)
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

const rejection = async (work: Promise<unknown>): Promise<unknown> => {
  const outcome = await work.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

describe('authorship outlives membership', () => {
  test('a panel records who created it, and loads them by relation', async () => {
    const [panel] = await db
      .insert(panels)
      .values({ orgId, slug: 'authored', name: 'Authored', createdBy: userId })
      .returning()
    expect(panel?.createdBy).toBe(userId)

    const loaded = await db.query.panels.findFirst({
      where: eq(panels.id, panel?.id ?? ''),
      with: { author: true },
    })
    expect(loaded?.author?.name).toBe('Departing Author')
  })

  test('removing the author from the org does NOT touch what they authored', async () => {
    /**
     * The case the whole design turns on. `org_members` cascades from `user`, so pointing
     * authorship at membership would have deleted this panel's author along with the
     * membership row — silently, through a cascade rule rather than a decision.
     */
    await db
      .delete(orgMembers)
      .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))

    const memberships = await db.query.orgMembers.findMany({
      where: eq(orgMembers.userId, userId),
    })
    expect(memberships).toHaveLength(0)

    const stillAuthored = await db.query.panels.findFirst({
      where: eq(panels.orgId, orgId),
      with: { author: true },
    })
    expect(stillAuthored?.createdBy).toBe(userId)
    expect(stillAuthored?.author?.name).toBe('Departing Author')
  })

  test('a user who authored something cannot be deleted', async () => {
    /**
     * RESTRICT rather than SET NULL, deliberately. Nulling authorship on delete would
     * destroy ledger evidence through a cascade rule — the deletion would look routine
     * and a payout claim would quietly disappear. This fails loudly instead, which is
     * what forces the real answer: anonymise the user, never drop the row. That is also
     * what erasure requires — scrubbing personal data, not deleting the record.
     */
    const error = await rejection(db.delete(user).where(eq(user.id, userId)))
    // 23001 = restrict_violation, NOT the generic 23503 foreign_key_violation. The
    // distinction is the assertion: Postgres raises 23001 only for ON DELETE RESTRICT,
    // which is checked immediately, and 23503 for NO ACTION, which defers to the end of
    // the statement and can be sidestepped inside a transaction. This confirms which one
    // is actually in place rather than merely that something objected.
    expect(errnoOf(error)).toBe('23001')
  })

  test('anonymising the author keeps the ledger link intact', async () => {
    // The path RESTRICT forces, and the reason it is not a dead end: the personal data
    // goes, the identity that payouts attach to stays.
    await db
      .update(user)
      .set({ name: 'Redacted', email: `redacted-${userId}@invalid.test` })
      .where(eq(user.id, userId))

    const stillAuthored = await db.query.panels.findFirst({
      where: eq(panels.orgId, orgId),
      with: { author: true },
    })
    expect(stillAuthored?.createdBy).toBe(userId)
    expect(stillAuthored?.author?.name).toBe('Redacted')
  })

  test('authorship is nullable — the system creates rows too', async () => {
    const [seeded] = await db
      .insert(panels)
      .values({ orgId, slug: 'system-made', name: 'System made' })
      .returning()
    expect(seeded?.createdBy).toBeNull()
  })
})
