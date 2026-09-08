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
    await app`
      INSERT INTO pgboss.queue_stats (name, captured_on, queued_count)
      VALUES ('privilege-probe', now(), 0)
      ON CONFLICT DO NOTHING
    `
    await app`DELETE FROM pgboss.queue_stats WHERE name = 'privilege-probe'`
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
    } finally {
      await migrator`DROP TABLE pgboss.upgrade_probe`
    }
  })
})
