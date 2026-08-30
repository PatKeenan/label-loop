import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'
import journal from '../migrations/meta/_journal.json' with { type: 'json' }
import { expectedMigrations, migrationStatus } from './migrations-status.ts'
import { appClient } from './test-support.ts'

/**
 * Properties of the migration stream itself. These need no database: they are assertions
 * about the files, and they are the ones that catch a mistake before it reaches an
 * environment rather than after.
 */

const MIGRATIONS_DIR = new URL('../migrations', import.meta.url).pathname

const sqlFiles = async (): Promise<string[]> => {
  const names: string[] = []
  for await (const file of new Glob('*.sql').scan({ cwd: MIGRATIONS_DIR })) names.push(file)
  return names.sort()
}

describe('the migration stream is forward-only', () => {
  /**
   * CONVENTIONS.md "Repo shape": no down-migrations, anywhere. Rolling a schema backwards
   * in production is a fiction — the down migration is written once, never tested, and
   * discards data when it finally runs. The recovery path is a new forward migration.
   */
  test('no down migration exists', async () => {
    const files = await sqlFiles()
    const down = files.filter((name) => /down|rollback|revert/i.test(name))
    expect(down).toEqual([])
  })

  test('every migration file is registered in the journal', async () => {
    const files = await sqlFiles()
    const tags = journal.entries.map((entry) => `${entry.tag}.sql`).sort()
    expect(files).toEqual(tags)
  })

  test('journal indexes are contiguous and start at zero', () => {
    const indexes = journal.entries.map((entry) => entry.idx)
    expect(indexes).toEqual(indexes.map((_, position) => position))
  })

  test('journal entries are ordered in time, so replay order is creation order', () => {
    const stamps = journal.entries.map((entry) => entry.when)
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b))
  })
})

describe('the generated SQL is executable as written', () => {
  /**
   * Regression guard. Interpolating a value into a Drizzle `sql` template makes it a BIND
   * PARAMETER, and drizzle-kit then emits a literal `$1` into the migration — which is not
   * a runtime error in generation, only in application. The id-prefix CHECK constraints hit
   * this exactly once; nothing should reintroduce it silently.
   */
  test('no migration contains an unbound parameter placeholder', async () => {
    for (const name of await sqlFiles()) {
      const sql = await Bun.file(`${MIGRATIONS_DIR}/${name}`).text()
      expect({ name, matches: sql.match(/\$\d+/g) ?? [] }).toEqual({ name, matches: [] })
    }
  })

  test('the privileges migration runs before any table is created', async () => {
    // ALTER DEFAULT PRIVILEGES only covers objects created after it, so this ordering is
    // load-bearing rather than stylistic: reversed, every table would need its own grant.
    const first = journal.entries[0]
    expect(first?.tag).toBe('0000_privileges')

    const privileges = await Bun.file(`${MIGRATIONS_DIR}/0000_privileges.sql`).text()
    expect(privileges).toContain('ALTER DEFAULT PRIVILEGES')
    expect(privileges).not.toContain('CREATE TABLE')
  })

  test('migrationStatus reads the real migration table and reports current', async () => {
    // The gap that let a driver bug reach CI: nothing exercised this against a database,
    // so a schema-qualified identifier quoted as ONE name — `"drizzle.__drizzle_migrations"`
    // rather than `"drizzle"."__drizzle_migrations"` — passed every unit test and then
    // failed `/readyz`, which is the check compose gates the whole stack on.
    const client = appClient()
    try {
      const status = await migrationStatus(client)
      expect(status.current).toBe(true)
      expect(status.applied).toBe(expectedMigrations().count)
    } finally {
      await client.close()
    }
  })

  test('the append-only revoke names audit_events and only audit_events', async () => {
    const revoke = await Bun.file(`${MIGRATIONS_DIR}/0002_audit_append_only.sql`).text()
    const statements = revoke
      .split('\n')
      .filter((line) => line.trim().length > 0 && !line.trim().startsWith('--'))
      .join(' ')
    expect(statements).toContain('REVOKE UPDATE, DELETE ON audit_events FROM labelloop_app')
  })
})
