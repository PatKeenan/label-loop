import { afterAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { appClient, migratorClient, sqlStateOf } from '../test-support.ts'

/**
 * `pnv_` and `jdv_` rows are immutable, and Postgres is what makes that true (ADR-0003).
 *
 * Before this, immutability rested on two conventions: no code updated these rows, and
 * there was no mutable column to update. Neither survives a bug, a maintenance script, or
 * anyone holding the app credentials — and the entire eval story is "agreement plotted per
 * immutable version", so a threshold or a rubric that can move underneath a timeline makes
 * every timeline suspect.
 *
 * This widens what the append-only migration called the single deliberate exception. The
 * justification is that these are the same class of claim as the audit log, so they get
 * the same class of enforcement.
 */

const app = appClient()
const migrator = migratorClient()

const INSUFFICIENT_PRIVILEGE = '42501'

afterAll(async () => {
  await app.close()
  await migrator.close()
})

const rejection = async (query: Promise<unknown>): Promise<unknown> => {
  const outcome = await query.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

describe('the app role cannot rewrite an immutable version', () => {
  for (const table of ['panel_versions', 'judge_versions'] as const) {
    test(`${table}: UPDATE is refused`, async () => {
      const error = await rejection(app`UPDATE ${app(table)} SET version = version WHERE false`)
      expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    test(`${table}: DELETE is refused`, async () => {
      const error = await rejection(app`DELETE FROM ${app(table)} WHERE false`)
      expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
    })

    test(`${table}: INSERT and SELECT still work — versions are still created`, async () => {
      const rows = await app`SELECT id FROM ${app(table)} LIMIT 1`
      expect(Array.isArray(rows)).toBe(true)
    })

    test(`${table}: the grant is exactly INSERT and SELECT`, async () => {
      const rows = (await migrator`
        SELECT privilege_type FROM information_schema.table_privileges
        WHERE grantee = 'labelloop_app' AND table_name = ${table}
        ORDER BY privilege_type
      `) as Array<{ privilege_type: string }>
      expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT'])
    })
  }
})

describe('the revoke does not break the things that still have to work', () => {
  test('deleting an org still cascades through its versions', async () => {
    /**
     * The objection that had to be tested before committing to the revoke, because getting
     * it wrong would have made tenant deletion impossible. A referential action runs with
     * the privileges of the table OWNER, not the caller — so the cascade reaches rows the
     * app role cannot delete directly.
     */
    const orgId = newId('org_')
    const panelId = newId('pnl_')
    const versionId = newId('pnv_')
    await app`INSERT INTO orgs (id, slug, name) VALUES (${orgId}, ${orgId}, 'Cascade probe')`
    await app`
      INSERT INTO panels (id, org_id, slug, name) VALUES (${panelId}, ${orgId}, 'p', 'P')
    `
    await app`
      INSERT INTO panel_versions (id, panel_id, version, threshold)
      VALUES (${versionId}, ${panelId}, 1, 0.5)
    `

    await app`DELETE FROM orgs WHERE id = ${orgId}`

    const left = await app`SELECT id FROM panel_versions WHERE id = ${versionId}`
    expect(left).toHaveLength(0)
  })

  test('activation still works, because the pointer lives on panels', async () => {
    // The two decisions compose only because activation is a pointer on `panels` rather
    // than an `is_current` flag on the version row — a flag would have needed the UPDATE
    // privilege this migration just removed.
    const rows = (await migrator`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'labelloop_app' AND table_name = 'panels' AND privilege_type = 'UPDATE'
    `) as Array<{ privilege_type: string }>
    expect(rows).toHaveLength(1)
  })
})
