import { afterAll, describe, expect, test } from 'bun:test'
import { QUEUE_SCHEMA, QUEUES } from './queue.ts'
import {
  appClient,
  EPHEMERAL_QUEUE_PREFIX,
  migratorClient,
  rejection,
  sqlStateOf,
} from './test-support.ts'

/**
 * The queue's schema is the one part of this database a library wrote, which makes it the
 * one part where the privilege boundary could quietly not apply. pg-boss installs and
 * migrates its own tables on `start()` by default, and the app role is the role that would
 * be doing it — so these assert the two halves of the arrangement `db:migrate` sets up:
 * the app role can WORK the queue, and it cannot CHANGE it.
 *
 * Like the rest of this package's tests, they do not skip when there is no database
 * (`test-support.ts` says why). The claims are about what Postgres does.
 */

const app = appClient()
const migrator = migratorClient()

afterAll(async () => {
  await app.close()
  await migrator.close()
})

const INSUFFICIENT_PRIVILEGE = '42501'

describe('the queue schema (installed by the migrator, worked by the app role)', () => {
  test('every declared queue exists, created by the migration step rather than at runtime', async () => {
    // Equality, not containment: the claim is that the migration installed the queues we
    // declare AND nothing else — a queue created at runtime by a stray `createQueue` would
    // show up here as the extra row it is.
    //
    // The one exclusion is `ephemeralQueue`'s prefix (`test-support.ts`). A test that
    // provisions its own queue drops it again on the way out and on the way back in, so a
    // row with that prefix means a run was killed between the two — a fact about the last
    // test run rather than about the migration this test is asserting on. Left in, it would
    // turn one interrupted `bun test` into a failure here that says nothing true.
    const rows = (await app`
      SELECT name FROM pgboss.queue
      WHERE name NOT LIKE ${`${EPHEMERAL_QUEUE_PREFIX}%`}
      ORDER BY name
    `) as Array<{ name: string }>
    expect(rows.map((row) => row.name).sort()).toEqual([...QUEUES].sort())
  })

  test('the schema is owned by the migrator, not by the role the API connects with', async () => {
    const rows = (await app`
      SELECT nspowner::regrole::text AS owner
      FROM pg_namespace WHERE nspname = ${QUEUE_SCHEMA}
    `) as Array<{ owner: string }>
    expect(rows[0]?.owner).toBe('labelloop_migrator')
  })

  test('the app role can read and write the queue — DML is granted', async () => {
    // Reading through pg-boss's own tables here is a PRIVILEGE assertion, not application
    // code reading queue internals (ADR-0017 bans the second, and `job_attempts` exists so
    // nothing has to).
    const rows = (await app`SELECT count(*)::int AS n FROM pgboss.job`) as Array<{ n: number }>
    expect(rows[0]?.n).toBeGreaterThanOrEqual(0)

    // **The write half is asserted on the GRANT, not by inserting a probe row**, and the
    // reason is worth writing down because the obvious version is wrong in a way that only
    // shows up later.
    //
    // The first version of this test inserted into `pgboss.queue_stats` at `now()`. That
    // table is DAILY PARTITIONED, and pg-boss creates partitions from its maintenance loop
    // rather than at migration — so the insert lands only if a partition covering today
    // happens to exist. On a database migrated today it does; on one migrated on any
    // earlier day it does not, and Postgres rejects the row with `23514`,
    // `no partition of relation "queue_stats" found`. CI is green either way, because every
    // CI run gets a freshly migrated database — so the failure appears only on a developer's
    // machine, for a reason that has nothing to do with privileges. Exactly the class of
    // flake `ephemeralQueue` was written to remove, reintroduced one table over.
    //
    // Asking the catalogue instead is both robust and STRICTER than the original: it covers
    // every pg-boss table and all four verbs, where the probe covered one table and two.
    // `has_table_privilege`'s two-argument form asks about the connected role, so this is
    // literally "may I, the app role" rather than a role name repeated from the migration.
    const ungranted = (await app`
      SELECT c.relname::text AS name, p.verb::text AS verb
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) AS p(verb)
      WHERE n.nspname = ${QUEUE_SCHEMA}
        AND c.relkind IN ('r', 'p')
        AND NOT has_table_privilege(c.oid, p.verb)
      ORDER BY 1, 2
    `) as Array<{ name: string; verb: string }>
    expect(ungranted).toEqual([])

    // And a sanity check on the sweep itself: a query that found no tables would report no
    // missing grants and pass while asserting nothing at all.
    const counted = (await app`
      SELECT count(*)::int AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${QUEUE_SCHEMA} AND c.relkind IN ('r', 'p')
    `) as Array<{ n: number }>
    expect(counted[0]?.n ?? 0).toBeGreaterThan(0)
  })

  test('the app role CANNOT install or alter the queue schema — this is the whole point', async () => {
    // If this ever passes, pg-boss's default `migrate: true` would silently work at app
    // runtime and the migrator/app split would be decoration.
    expect(sqlStateOf(await rejection(app`CREATE TABLE pgboss.should_not_exist (id text)`))).toBe(
      INSUFFICIENT_PRIVILEGE,
    )
    expect(
      sqlStateOf(await rejection(app`ALTER TABLE pgboss.queue ADD COLUMN should_not_exist text`)),
    ).toBe(INSUFFICIENT_PRIVILEGE)
  })

  test('a table a future pg-boss version adds is granted automatically', async () => {
    // `ALTER DEFAULT PRIVILEGES` is the half of the grant that reaches forward. Without it
    // an upgrade that adds a table would break the running API on whichever query touches
    // it first — a permissions bug that looks like a queue bug, months later.
    await migrator`CREATE TABLE pgboss.upgrade_probe (id text)`
    try {
      const rows = (await app`SELECT count(*)::int AS n FROM pgboss.upgrade_probe`) as Array<{
        n: number
      }>
      expect(rows[0]?.n).toBe(0)

      // All four verbs EXERCISED rather than asked about, which is the half the grant sweep
      // above cannot give: a privilege that is granted and still does not work — an owner
      // mismatch, a policy, a revoke further down — would pass a catalogue query and fail
      // here. This table is created and dropped by the test, so unlike pg-boss's own tables
      // it carries no partitioning and no shared state to trip over.
      await app`INSERT INTO pgboss.upgrade_probe (id) VALUES ('probe')`
      await app`UPDATE pgboss.upgrade_probe SET id = 'probe-updated' WHERE id = 'probe'`
      await app`DELETE FROM pgboss.upgrade_probe WHERE id = 'probe-updated'`
      const after = (await app`SELECT count(*)::int AS n FROM pgboss.upgrade_probe`) as Array<{
        n: number
      }>
      expect(after[0]?.n).toBe(0)
    } finally {
      await migrator`DROP TABLE pgboss.upgrade_probe`
    }
  })
})
