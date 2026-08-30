import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { eq } from 'drizzle-orm'
import { createDatabase } from '../client.ts'
import { orgs } from './orgs.ts'
import { panelVersions } from './panel-versions.ts'
import { panels } from './panels.ts'

/**
 * Which version is live is a POINTER, not the highest version number.
 *
 * Version order is history; activation is a separate fact. Conflating them makes two
 * things impossible that a customer will want on day one — rolling back, and preparing a
 * version without it judging traffic the moment it is inserted — so these tests are mostly
 * about those two, plus the integrity rule that stops a panel activating someone else's
 * version.
 */

const db = createDatabase({ url: process.env.DATABASE_URL ?? '', max: 2 })

const orgId = newId('org_')
const panelA = newId('pnl_')
const panelB = newId('pnl_')
const v1 = newId('pnv_')
const v2 = newId('pnv_')
const bV1 = newId('pnv_')

beforeAll(async () => {
  await db.insert(orgs).values({ id: orgId, slug: orgId, name: 'Activation fixtures' })
  await db.insert(panels).values([
    { id: panelA, orgId, slug: 'panel-a', name: 'Panel A' },
    { id: panelB, orgId, slug: 'panel-b', name: 'Panel B' },
  ])
  await db.insert(panelVersions).values([
    { id: v1, panelId: panelA, version: 1, threshold: 0.5 },
    { id: v2, panelId: panelA, version: 2, threshold: 0.9 },
    { id: bV1, panelId: panelB, version: 1, threshold: 0.5 },
  ])
})

afterAll(async () => {
  await db.delete(orgs).where(eq(orgs.id, orgId))
  await db.close()
})

const rejection = async (work: Promise<unknown>): Promise<unknown> => {
  const outcome = await work.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

const sqlStateOf = (error: unknown): string | undefined => {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== null && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    if ('code' in current) return String((current as { code: unknown }).code)
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

const activate = (panelId: string, versionId: string | null) =>
  db.update(panels).set({ currentVersionId: versionId }).where(eq(panels.id, panelId))

describe('activation is a pointer', () => {
  test('a panel starts with no live version', async () => {
    const panel = await db.query.panels.findFirst({ where: eq(panels.id, panelA) })
    expect(panel?.currentVersionId).toBeNull()
  })

  test('a newer version does NOT go live merely by existing', async () => {
    /**
     * The property that makes drafts possible. v2 exists and is the highest version, and
     * the panel is still serving nothing — under a "highest version wins" rule, v2 would
     * have started judging traffic the instant it was inserted.
     */
    const versions = await db.query.panelVersions.findMany({
      where: eq(panelVersions.panelId, panelA),
    })
    expect(versions).toHaveLength(2)
    const panel = await db.query.panels.findFirst({ where: eq(panels.id, panelA) })
    expect(panel?.currentVersionId).toBeNull()
  })

  test('activating resolves through the relation', async () => {
    await activate(panelA, v2)
    const panel = await db.query.panels.findFirst({
      where: eq(panels.id, panelA),
      with: { currentVersion: true },
    })
    expect(panel?.currentVersion?.id).toBe(v2)
    expect(panel?.currentVersion?.threshold).toBeCloseTo(0.9)
  })

  test('rolling BACK to an older version is a pointer move, not a new version', async () => {
    // The thing "highest version wins" cannot express at all: reverting would have meant
    // copying v1's configuration forward into a v3, which is a different fact.
    await activate(panelA, v1)
    const panel = await db.query.panels.findFirst({
      where: eq(panels.id, panelA),
      with: { currentVersion: true, versions: true },
    })
    expect(panel?.currentVersion?.id).toBe(v1)
    expect(panel?.currentVersion?.threshold).toBeCloseTo(0.5)
    // History is untouched — v2 still exists, it is simply not serving.
    expect(panel?.versions).toHaveLength(2)
  })

  test('a panel CANNOT activate another panel’s version', async () => {
    /**
     * Why the foreign key is composite. Referencing `panel_versions.id` alone would accept
     * this: the row exists, so a plain reference is satisfied, and panel B would quietly
     * serve panel A's judges. Carrying `id` into the key makes the version prove it
     * belongs here.
     */
    const error = await rejection(activate(panelB, v1))
    expect(sqlStateOf(error)).toBe('23503')

    const panel = await db.query.panels.findFirst({ where: eq(panels.id, panelB) })
    expect(panel?.currentVersionId).toBeNull()
  })

  test('a panel can be deactivated back to nothing', async () => {
    await activate(panelA, null)
    const panel = await db.query.panels.findFirst({ where: eq(panels.id, panelA) })
    expect(panel?.currentVersionId).toBeNull()
  })

  test('version history and the live pointer are separate relations', async () => {
    await activate(panelA, v1)
    const panel = await db.query.panels.findFirst({
      where: eq(panels.id, panelA),
      with: { versions: true, currentVersion: true },
    })
    expect(panel?.versions.map((v) => v.version).sort()).toEqual([1, 2])
    expect(panel?.currentVersion?.version).toBe(1)
  })
})
