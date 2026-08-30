import { PgBoss } from 'pg-boss'
import { APP_ROLE } from './roles.ts'
import { createSqlClient } from './sql-client.ts'

/**
 * The queue's schema, installed by the MIGRATOR and never at application runtime
 * (CONVENTIONS.md "Data rules"). pg-boss will happily create and migrate its own tables on
 * `start()`, which is convenient and is exactly the thing the two-role split exists to
 * forbid: an app role that can install a schema is an app role with DDL, and the whole
 * privilege boundary becomes a naming convention.
 *
 * It lives in `packages/db` rather than beside the handlers because this package owns the
 * shape of the database and the grants that fence it — including a schema it did not
 * write. `apps/api/src/jobs` owns the queue's BEHAVIOUR; this file owns its existence.
 *
 * Everything here is idempotent: `db:migrate` re-runs it on every deploy, which is also
 * what keeps the grants below correct after a pg-boss upgrade adds a table.
 */

export const QUEUE_SCHEMA = 'pgboss'

/**
 * Every queue the system has. They are created here, as the migrator, for the same reason
 * the tables are: creating a queue is a schema act, and a partitioned queue is literally a
 * new table. A handler in `apps/api` works a queue named here and creates nothing.
 *
 * A worker started against a queue that does not exist fails loudly at boot, which is the
 * correct failure — it says "run the migrations", rather than serving traffic whose
 * follow-up work quietly goes nowhere.
 */
export const QUEUES = ['record-evaluation'] as const

export type QueueName = (typeof QUEUES)[number]

/**
 * The app role's access to a schema it can never own. USAGE and DML, no CREATE — the same
 * shape as `public`, arrived at differently: `public`'s grants come from the migration
 * stream, and these cannot, because the objects they cover are created by a library on the
 * far side of it.
 *
 * `ALL TABLES` covers what exists now and `ALTER DEFAULT PRIVILEGES` covers what a future
 * pg-boss version adds — both, because neither alone is sufficient: default privileges
 * cannot reach backwards to the tables just installed, and a one-time GRANT cannot reach
 * forward to the ones the next upgrade writes.
 */
const grantsSql = (schema: string) => `
  GRANT USAGE ON SCHEMA ${schema} TO ${APP_ROLE};
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${APP_ROLE};
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${APP_ROLE};
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${APP_ROLE};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema}
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROLE};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROLE};
  ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${APP_ROLE};
`

/**
 * Install or upgrade the queue's schema and declare every queue, as the migrator.
 *
 * `supervise` and `schedule` are off: this instance exists to write DDL and then leave.
 * Starting the maintenance loops here would have a short-lived migration process compete
 * with the running API for the same jobs.
 */
export const installQueueSchema = async (migrationUrl: string): Promise<void> => {
  const boss = new PgBoss({
    connectionString: migrationUrl,
    schema: QUEUE_SCHEMA,
    max: 1,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  })

  try {
    await boss.start()
    for (const name of QUEUES) await boss.createQueue(name)
  } finally {
    await boss.stop({ graceful: false })
  }

  const migrator = createSqlClient({ url: migrationUrl, max: 1 })
  try {
    await migrator.unsafe(grantsSql(QUEUE_SCHEMA))
  } finally {
    await migrator.close()
  }
}
