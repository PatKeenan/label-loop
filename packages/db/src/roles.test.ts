import { afterAll, describe, expect, test } from 'bun:test'
import { APP_ROLE, MIGRATOR_ROLE, READONLY_ROLE } from './roles.ts'
import { appClient, migratorClient, readonlyClient, sqlStateOf } from './test-support.ts'

/**
 * The three-way privilege split (CONVENTIONS.md "Data rules"): a migrator that owns DDL, an
 * app role that holds DML only, and a readonly role that can only SELECT. Least privilege
 * with a concrete payoff at each step — an app role without DDL means a SQL-injection bug
 * cannot drop `traces` whatever it manages to get executed, and a dashboard credential
 * without DML means a Grafana panel cannot corrupt the table it is drawing (ADR-0045).
 */

const app = appClient()
const migrator = migratorClient()
const readonly = readonlyClient()

const INSUFFICIENT_PRIVILEGE = '42501'

afterAll(async () => {
  await app.close()
  await migrator.close()
  await readonly.close()
})

const rejection = async (query: Promise<unknown>): Promise<unknown> => {
  const outcome = await query.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

describe('the three roles are what the API, the migrations and Grafana connect as', () => {
  test('DATABASE_URL is the app role', async () => {
    const rows = (await app`SELECT current_user`) as Array<{ current_user: string }>
    expect(rows[0]?.current_user).toBe(APP_ROLE)
  })

  test('DATABASE_MIGRATION_URL is the migrator role', async () => {
    const rows = (await migrator`SELECT current_user`) as Array<{ current_user: string }>
    expect(rows[0]?.current_user).toBe(MIGRATOR_ROLE)
  })

  test('DATABASE_READONLY_URL is the readonly role', async () => {
    const rows = (await readonly`SELECT current_user`) as Array<{ current_user: string }>
    expect(rows[0]?.current_user).toBe(READONLY_ROLE)
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

describe('the readonly role can SELECT and nothing else (ADR-0045)', () => {
  /**
   * The reason this role exists at all: Grafana needs a database credential for the per-key
   * usage panel (ADR-0042), and neither existing role is safe to hand it. The migrator owns
   * DDL; the app role can `INSERT` and `DELETE`. What follows is the difference between
   * saying a dashboard cannot write and it being unable to.
   */
  test('it can read a table', async () => {
    await readonly`SELECT id FROM traces LIMIT 1`
  })

  test('it can read the column the per-key usage panel groups by', async () => {
    // Named specifically rather than folded into the SELECT above, because THIS is the
    // query the role was created for. A grant that covered `traces` but not the column the
    // panel reads would pass a generic read test and fail the only one that matters.
    await readonly`SELECT api_key_id, count(*) FROM traces GROUP BY api_key_id`
  })

  test('it cannot INSERT', async () => {
    const error = await rejection(
      readonly`INSERT INTO traces (id, org_id, panel_id) VALUES ('tr_x', 'org_x', 'pnl_x')`,
    )
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
  })

  test('it cannot UPDATE', async () => {
    const error = await rejection(readonly`UPDATE traces SET org_id = 'org_x'`)
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
  })

  test('it cannot DELETE', async () => {
    const error = await rejection(readonly`DELETE FROM traces`)
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
  })

  test('it cannot issue DDL', async () => {
    const created = await rejection(readonly`CREATE TABLE readonly_should_not_manage (id text)`)
    expect(sqlStateOf(created)).toBe(INSUFFICIENT_PRIVILEGE)
    // ALTER is refused on ownership rather than on a grant, so it reports differently. Both
    // are asserted because they are different mechanisms, and a role that could ALTER but
    // not CREATE would still be able to drop a NOT NULL off a column a dashboard reads.
    const altered = await rejection(readonly`ALTER TABLE traces ADD COLUMN injected text`)
    expect(String(altered)).toContain('must be owner')
  })

  test('audit_events stays append-only for it BY CONSTRUCTION — asserted anyway', async () => {
    // A SELECT-only grant cannot violate an append-only invariant, so this needs no special
    // case in the migration. "Needs no special case" is exactly the kind of claim that
    // rots quietly, which is what tests are for. Note it cannot even INSERT here, where the
    // app role can: append-only is a ceiling on the app role and a floor this role is below.
    await readonly`SELECT id FROM audit_events LIMIT 1`
    const inserted = await rejection(
      readonly`INSERT INTO audit_events (id, org_id, action) VALUES ('aud_x', 'org_x', 'x')`,
    )
    expect(sqlStateOf(inserted)).toBe(INSUFFICIENT_PRIVILEGE)
    const deleted = await rejection(readonly`DELETE FROM audit_events`)
    expect(sqlStateOf(deleted)).toBe(INSUFFICIENT_PRIVILEGE)
  })
})

describe('the readonly grant covers tables from BOTH halves of the migration', () => {
  /**
   * The trap ADR-0045 names, and the one `0000_privileges.sql` already documents for
   * `drizzle.__drizzle_migrations`: `ALTER DEFAULT PRIVILEGES` only ever covers objects
   * created AFTER it runs. A role introduced at migration 10 is on the wrong side of every
   * table created in 1 through 9, so the migration needs an explicit
   * `GRANT SELECT ON ALL TABLES` as well as the defaults.
   *
   * Two tests, because the halves fail independently and a single one would hide it: drop
   * the explicit grant and only the first breaks; drop the defaults and only the second.
   */
  test('a table created BEFORE the role existed is readable', async () => {
    // `traces` comes from 0001, nine migrations before this role had any grant at all.
    await readonly`SELECT id FROM traces LIMIT 1`
  })

  test('a table created AFTER it is readable with no explicit grant', async () => {
    await migrator`CREATE TABLE readonly_default_probe (id text PRIMARY KEY)`
    try {
      const rows = await readonly`SELECT id FROM readonly_default_probe`
      expect(rows).toHaveLength(0)
      // And still only readable. Default privileges granting more than SELECT would be a
      // silent widening that no other test would notice.
      const error = await rejection(
        readonly`INSERT INTO readonly_default_probe (id) VALUES ('probe')`,
      )
      expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)
    } finally {
      await migrator`DROP TABLE readonly_default_probe`
    }
  })
})
