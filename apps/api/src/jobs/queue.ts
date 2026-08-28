import { QUEUE_SCHEMA, QUEUES, type QueueName } from '@labelloop/db'
import { PgBoss } from 'pg-boss'

/**
 * The queue seam: a small port over "put this work down and pick it up later", plus the
 * pg-boss adapter that implements it (ADR-0006 — Postgres is the queue until load testing
 * proves otherwise).
 *
 * It is a port for the same reason `ModelProvider` is one. ADR-0006's promise is that
 * replacing the queue stays an evidence-driven change rather than a rewrite, and a promise
 * like that is only worth something if the application talks to an interface it could
 * satisfy twice. Everything pg-boss-shaped — its options, its batch handler signature, its
 * job metadata — stops at this file.
 */

/**
 * What every job carries. Both ids, deliberately: `request_id` is what joins a job's log
 * lines to the request that enqueued it, and `trace_id` is the permanent row the work is
 * about (ADR-0010). A job that carried only its own id would be a dead end in a log search.
 */
export type JobPayload = {
  trace_id: string
  request_id: string
}

export type JobDelivery = {
  /** The queue's id for this job. Stable across retries, which is what makes it a key. */
  jobId: string
  queue: QueueName
  payload: JobPayload
}

export type JobHandler = (delivery: JobDelivery) => Promise<void>

export type JobQueue = {
  /** Enqueue one job. Returns the queue's id for it, for the enqueue log line. */
  send: (queue: QueueName, payload: JobPayload) => Promise<string | null>
  /** Register the handler for a queue. Idempotency is the HANDLER's job, not the queue's. */
  work: (queue: QueueName, handler: JobHandler) => Promise<void>
  /** Rejects, naming the reason, when the queue is not answering. `/readyz` calls it. */
  check: () => Promise<void>
  start: () => Promise<void>
  /** Drains in-flight jobs, then stops. Called by the shutdown path after requests drain. */
  stop: () => Promise<void>
}

/** How long a shutdown waits for in-flight jobs before giving up on them. */
const DRAIN_TIMEOUT_MS = 15_000

/**
 * A payload that arrived from our own `send` a moment ago still gets checked, because the
 * two ends of a queue are not deployed at the same instant: a job enqueued by the previous
 * release is delivered to this one. Failing loudly beats a handler reading `undefined`.
 */
const isJobPayload = (value: unknown): value is JobPayload =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Partial<JobPayload>).trace_id === 'string' &&
  typeof (value as Partial<JobPayload>).request_id === 'string'

export type PgBossQueueOptions = {
  /** The APP role's connection. DML only — it cannot install the schema below it. */
  url: string
  /**
   * Its own pool, separate from the API's. pg-boss polls on a timer and holds a connection
   * while it fetches, and sharing the request pool would let queue maintenance take
   * connections a request needs. Bounded small for the mirror-image reason: two pools
   * against one Postgres is two claims on the same `max_connections`.
   */
  poolMax: number
  /**
   * Where pg-boss's out-of-band failures go — a maintenance query that failed, a poll that
   * could not reach Postgres. They arrive on an event emitter rather than as a rejected
   * promise, so without this they are unhandled and silent.
   */
  onError: (error: unknown) => void
}

export const createPgBossQueue = ({ url, poolMax, onError }: PgBossQueueOptions): JobQueue => {
  const boss = new PgBoss({
    connectionString: url,
    schema: QUEUE_SCHEMA,
    max: poolMax,
    /**
     * The two options this whole arrangement turns on. pg-boss defaults both to true and
     * would install and upgrade its own schema the first time the API started — as the app
     * role, which holds DML and nothing else. `db:migrate` does it as the migrator instead
     * (`packages/db/src/queue.ts`), so a schema the application cannot write is also a
     * schema a bug in the application cannot damage.
     *
     * With them off, `start()` REFUSES when the schema is missing or behind, which is the
     * failure worth having: it says "run the migrations" at boot rather than serving
     * traffic whose follow-up work goes nowhere.
     */
    migrate: false,
    createSchema: false,
    /** Retry, expiry and archival maintenance. All DML, so the app role can run it. */
    supervise: true,
    /** No cron jobs exist. Off rather than idling. */
    schedule: false,
  })

  boss.on('error', onError)

  return {
    start: async () => {
      await boss.start()
    },

    stop: async () => {
      await boss.stop({ graceful: true, timeout: DRAIN_TIMEOUT_MS })
    },

    send: (queue, payload) => boss.send(queue, payload),

    work: async (queue, handler) => {
      await boss.work<JobPayload>(queue, { batchSize: 1 }, async (jobs) => {
        for (const job of jobs) {
          if (!isJobPayload(job.data)) {
            throw new Error(`job ${job.id} on queue ${queue} has a payload this build cannot read`)
          }
          await handler({ jobId: job.id, queue, payload: job.data })
        }
      })
    },

    check: async () => {
      // Round-trips to Postgres AND asserts the queues exist, which is the honest version
      // of "responsive": a reachable database whose queue rows are missing means the
      // migration step did not run, and a worker on a queue that does not exist is a
      // process that will never do any work while looking perfectly healthy.
      const found = new Set((await boss.getQueues([...QUEUES])).map((queue) => queue.name))
      const missing = QUEUES.filter((name) => !found.has(name))
      if (missing.length > 0) {
        throw new Error(`queue(s) not installed: ${missing.join(', ')} — run db:migrate`)
      }
    },
  }
}
