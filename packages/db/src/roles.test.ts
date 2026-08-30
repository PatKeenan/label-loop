import { afterAll, describe, expect, test } from 'bun:test'
import { APP_ROLE, MIGRATOR_ROLE } from './roles.ts'
import { appClient, migratorClient, sqlStateOf } from './test-support.ts'

/**
 * The migrator/app privilege split (CONVENTIONS.md "Data rules"): a migrator that owns DDL
 * and an app role that holds DML only. Least privilege with a concrete payoff — an app
 * role without DDL means a SQL-injection bug cannot drop `traces`, whatever it manages to
 * get executed.
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

describe('the two roles are what the API and the migrations connect as', () => {
  test('DATABASE_URL is the app role', async () => {
    const rows = (await app`SELECT current_user`) as Array<{ current_user: string }>
    expect(rows[0]?.current_user).toBe(APP_ROLE)
  })

  test('DATABASE_MIGRATION_URL is the migrator role', async () => {
    const rows = (await migrator`SELECT current_user`) as Array<{ current_user: string }>
    expect(rows[0]?.current_user).toBe(MIGRATOR_ROLE)
  })
})

describe('the app role holds DML and no DDL', () => {
  test('it can read a table it owns nothing of', async () => {
    await app`SELECT id FROM traces LIMIT 1`
  })

  test('it cannot ALTER a table', async () => {
    const error = await rejection(app`ALTER TABLE traces ADD COLUMN injected text`)
    expect(String(error)).toContain('must be owner')
  })

  test('it cannot DROP a table', async () => {
    await rejection(app`DROP TABLE traces`)
    // The table is still there — the point of the assertion, not the error text.
    await migrator`SELECT 1 FROM traces LIMIT 1`
  })

  test('it cannot CREATE a table in public', async () => {
    const error = await rejection(app`CREATE TABLE app_should_not_manage (id text)`)
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
  })

  test('it cannot CREATE a schema', async () => {
    const error = await rejection(app`CREATE SCHEMA app_should_not_manage`)
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
  })
})

describe('ALTER DEFAULT PRIVILEGES covers tables that do not exist yet', () => {
  /**
   * The reason default privileges exist rather than a GRANT per migration: a forgotten
   * grant does not fail the migration, it fails in production on the one endpoint that
   * touches the new table. This proves a table created AFTER the grants migration is
   * already readable and writable by the app role, with nobody having remembered anything.
   */
  test('a newly migrated table is usable by the app role with no explicit grant', async () => {
    await migrator`CREATE TABLE default_privilege_probe (id text PRIMARY KEY)`
    try {
      await app`INSERT INTO default_privilege_probe (id) VALUES ('probe')`
      const rows = await app`SELECT id FROM default_privilege_probe WHERE id = 'probe'`
      expect(rows).toHaveLength(1)
      await app`UPDATE default_privilege_probe SET id = 'probe2' WHERE id = 'probe'`
      await app`DELETE FROM default_privilege_probe WHERE id = 'probe2'`
    } finally {
      await migrator`DROP TABLE default_privilege_probe`
    }
  })
})

describe('the app role can read its own migration state', () => {
  /**
   * `/readyz` reports whether migrations are current, and it runs as the app role — so the
   * app needs SELECT on Drizzle's bookkeeping table. That table is created BEFORE the
   * first migration runs, so default privileges alone would not have covered it.
   */
  test('drizzle.__drizzle_migrations is readable by the app role', async () => {
    const rows = (await app`
      SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations
    `) as Array<{ n: number }>
    expect(rows[0]?.n).toBeGreaterThan(0)
  })
})
