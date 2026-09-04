import { PgBoss } from 'pg-boss'
import { QUEUE_SCHEMA, type QueueName } from './queue.ts'
import { createSqlClient } from './sql-client.ts'

/**
 * Connections for the database-backed tests.
 *
 * These tests deliberately do NOT skip when there is no database. The append-only
 * guarantee and the migrator/app privilege split are the two claims this package exists
 * to make, and a claim whose test silently skips is weaker than one with no test at all —
 * it reads green in CI while proving nothing. Missing configuration fails loudly and says
 * how to fix it.
 */

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set — the database tests need a running Postgres.\n` +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return value
}

/** The role the API connects with: DML only, no DDL, no UPDATE/DELETE on audit_events. */
export const appClient = () => createSqlClient({ url: required('DATABASE_URL'), max: 2 })

/** The role that owns the schema. Used only to set up fixtures a test then acts on. */
export const migratorClient = () =>
  createSqlClient({ url: required('DATABASE_MIGRATION_URL'), max: 2 })

/**
 * The SQLSTATE off a driver error (`42501` = insufficient_privilege), for asserting on the
 * cause rather than on a message. `node-postgres` exposes it as `code`; the previous driver
 * called it `errno`, which is what made this a rename rather than a no-op (ADR-0031).
 */
export const sqlStateOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined

/**
 * Run a statement that is expected to be REFUSED, and hand back the error to assert on.
 *
 * Awaiting a Bun `SQL` query object twice executes it twice and leaks a pooled connection
 * per extra run, so `expect(query).rejects` is the wrong shape here — one execution, one
 * result. Asserting the error rather than merely that it threw is the point: a bare "it
 * threw" also passes on a typo in the statement, which leaves the guarantee untested.
 */
export const rejection = async (query: Promise<unknown>): Promise<unknown> => {
  const outcome = await query.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

/**
 * The prefix every ephemeral test queue carries. Recognisable on sight in `pgboss.queue`,
 * and impossible to confuse with a declared queue: `QUEUES` names real work.
 */
export const EPHEMERAL_QUEUE_PREFIX = 'ephemeral-test--'

export type EphemeralQueue = {
  /**
   * Typed `QueueName` so the port under test accepts it without widening its own type. The
   * cast is deliberate and lives here rather than at the call site: `QueueName` is closed
   * so that application code cannot invent a queue, and a test that provisions its own is
   * the one exception — which is worth stating once, in a named helper, rather than
   * spelling out again in every test that needs one.
   */
  name: QueueName
  /** Drops the queue and anything left on it. Call it after the queue under test stops. */
  drop: () => Promise<void>
}

/**
 * A queue that exists for one test run and is dropped after it, created by the MIGRATOR
 * exactly as a declared queue is (`installQueueSchema`).
 *
 * **Why a test would want one.** A queue is a rendezvous, and `QUEUES` names queues the
 * whole system shares — so a test that sends on one and waits for its own worker to be
 * handed the job is asserting that it WON a race against every other pg-boss client
 * pointed at that database. On a developer machine that is a real competitor: the composed
 * stack's `api` container works `record-evaluation` against the same Postgres the host
 * tests use, and it fetches, fails (the trace a test invented does not exist), and hands
 * the job back for a retry the test may or may not still be waiting for. Losing that race
 * often enough leaves a backlog of stale jobs on the shared queue, and a `batchSize: 1`
 * worker then spends its polls delivering someone else's leftovers.
 *
 * Neither failure is a bug in the adapter, and no amount of waiting fixes either. A queue
 * nothing else is subscribed to removes the race rather than widening the window on it.
 *
 * The name is derived from `label` rather than randomised, so a run killed before its
 * cleanup leaves at most one recognisable row per label instead of accumulating them — and
 * the drop below happens on the way IN as well as out, which is what makes the starting
 * state identical whether or not the previous run finished.
 */
export const ephemeralQueue = async (label: string): Promise<EphemeralQueue> => {
  const url = required('DATABASE_MIGRATION_URL')
  const name = `${EPHEMERAL_QUEUE_PREFIX}${label}`

  const asMigrator = async (run: (boss: PgBoss) => Promise<void>): Promise<void> => {
    const boss = new PgBoss({
      connectionString: url,
      schema: QUEUE_SCHEMA,
      max: 1,
      // The same refusal the API runs under: this instance manages a queue, it does not
      // install the schema holding it. `db:migrate` did that.
      migrate: false,
      createSchema: false,
      // No maintenance and no cron. A short-lived instance that started the supervisor
      // would compete with the running API for the same jobs, which is the problem this
      // helper exists to remove rather than reproduce.
      supervise: false,
      schedule: false,
    })
    // pg-boss warns about an emitter with no `error` listener. Nothing here can emit on it
    // with the loops above turned off, so the listener is a formality rather than a sink.
    boss.on('error', () => {})
    try {
      await boss.start()
      await run(boss)
    } finally {
      await boss.stop({ graceful: false })
    }
  }

  // Delete before create. `deleteQueue` is a no-op on a queue that is not there and takes
  // the queue's jobs with it when it is, so this one line covers both "first run" and
  // "the last run was killed with a backlog on it".
  await asMigrator(async (boss) => {
    await boss.deleteQueue(name)
    await boss.createQueue(name)
  })

  return {
    name: name as QueueName,
    drop: () => asMigrator((boss) => boss.deleteQueue(name)),
  }
}
