import { afterAll, describe, expect, test } from 'bun:test'
import { createDatabase } from '../client.ts'

/**
 * Every edge of the relation graph, traversed against a real database.
 *
 * This exists because the failure it guards is invisible until it is expensive. Declaring
 * `.references()` without declaring `relations()` leaves `db.query.<table>` present and a
 * plain `findMany()` working, so the relational API looks configured — and the first
 * `with:` throws at RUNTIME, in whichever repository first tries to load a panel with its
 * judges. TypeScript does not catch it. So the test loads through every edge instead of
 * asserting that the relation objects exist, because "the object exists" was already true
 * when this was broken.
 *
 * It runs against the seeded fixtures, so `bun run db:seed` is part of the setup.
 */

const db = createDatabase({
  url: process.env.DATABASE_URL ?? '',
  max: 2,
})

afterAll(async () => {
  await db.close()
})

describe('the relational query API can traverse the domain', () => {
  test('a panel loads with its org, judges and versions', async () => {
    const panels = await db.query.panels.findMany({
      with: { org: true, judges: { with: { versions: true } }, versions: true },
    })
    expect(panels.length).toBeGreaterThan(0)
    const panel = panels[0]
    expect(panel?.org.slug).toBe('demo')
    expect(panel?.judges.map((judge) => judge.slug).sort()).toEqual([
      'is-bug',
      'is-feature',
      'is-question',
      'needs-human',
    ])
    // Each judge has exactly one immutable version at v1.
    expect(panel?.judges.every((judge) => judge.versions.length === 1)).toBe(true)
  })

  test('a panel version loads the judge set it PINS, through the join table', async () => {
    /**
     * The traversal that makes `pnv_` immutability mean something: the pinned set, not
     * "whatever judges the panel has now". Through `panel_version_judges` on purpose —
     * going via `panels.judges` would answer a different and much less useful question.
     */
    const versions = await db.query.panelVersions.findMany({
      with: { panel: true, judgeVersions: { with: { judgeVersion: { with: { judge: true } } } } },
    })
    const version = versions[0]
    expect(version?.panel.slug).toBe('issue-triage')
    expect(version?.judgeVersions).toHaveLength(4)

    const pinned = version?.judgeVersions.map((row) => row.judgeVersion)
    // Polarity survives the traversal, which is what the score will be computed from.
    const scoring = pinned?.filter((jdv) => jdv.polarity !== 'does_not_score')
    expect(scoring).toHaveLength(1)
    expect(scoring?.[0]?.judge.slug).toBe('needs-human')
    expect(scoring?.[0]?.required).toBe(true)
    expect(scoring?.[0]?.weight).toBe(1)
  })

  test('an api key loads its org and the panel it is scoped to', async () => {
    const keys = await db.query.apiKeys.findMany({ with: { org: true, panel: true } })
    const key = keys[0]
    expect(key?.name).toBe('Local development')
    expect(key?.panel.slug).toBe('issue-triage')
    expect(key?.org.slug).toBe('demo')
    // Never the plaintext: the column does not exist.
    expect(key).not.toHaveProperty('plaintext')
  })

  test('the trace edges resolve — including the key that authorised the call', async () => {
    /**
     * No traces exist until P4 writes one, so this asserts the graph rather than rows: the
     * query compiles and executes across every edge metering will need, which is the part
     * that would otherwise fail for the first time in a repository.
     */
    const traces = await db.query.traces.findMany({
      with: {
        org: true,
        panel: true,
        panelVersion: true,
        apiKey: true,
        verdicts: { with: { judgeVersion: true } },
      },
      limit: 1,
    })
    expect(Array.isArray(traces)).toBe(true)
  })

  test('an org loads its members and each member their user', async () => {
    const orgs = await db.query.orgs.findMany({
      with: { members: { with: { user: true } }, panels: true, apiKeys: true },
    })
    const org = orgs[0]
    expect(org?.slug).toBe('demo')
    expect(org?.panels).toHaveLength(1)
    expect(org?.apiKeys).toHaveLength(1)
    // No seeded user until P7 mounts better-auth; the edge still has to resolve.
    expect(Array.isArray(org?.members)).toBe(true)
  })

  test('the auth tables are in the graph too', async () => {
    const users = await db.query.user.findMany({
      with: { sessions: true, accounts: true, memberships: true },
      limit: 1,
    })
    expect(Array.isArray(users)).toBe(true)
  })

  test('audit events resolve their org', async () => {
    const events = await db.query.auditEvents.findMany({ with: { org: true }, limit: 1 })
    expect(Array.isArray(events)).toBe(true)
  })
})
