import { index, integer, pgTable, primaryKey, text } from 'drizzle-orm/pg-core'
import { jobAttemptStatus, timestampAt } from './columns.ts'
import { traces } from './traces.ts'

/**
 * The attempt ledger: one row per delivery of one job.
 *
 * CONVENTIONS.md requires jobs to be idempotent and to record their attempts in the
 * database, and ADR-0017 settles WHERE: in a table we own, never by reading pg-boss's
 * internal schema. The reason is ADR-0006's premise — Postgres is the queue until load
 * testing proves otherwise, and "we can replace the queue on evidence" stops being true
 * the moment application code SELECTs from its private tables.
 *
 * Storing the id the queue handed us is a different thing from reading its schema: it is
 * a correlation key, and it stays meaningful under a different queue because every queue
 * has one. It is the queue's own identifier rather than a prefixed ULID for the same
 * reason better-auth's ids are (CONVENTIONS.md "API rules"): we did not mint it.
 */
export const jobAttempts = pgTable(
  'job_attempts',
  {
    /** The queue's id for this job. Opaque to us, and the same across its retries. */
    jobId: text('job_id').notNull(),
    /**
     * Which delivery this is, counted by US. Deliberately not the queue's retry counter:
     * that number answers "how many times has the queue retried" and this one answers
     * "how many times has this job run", which differ whenever a worker dies without
     * reporting, and only the second is the question ADR-0017 says we must be able to
     * answer without the queue.
     */
    attempt: integer('attempt').notNull(),
    queue: text('queue').notNull(),
    /** The evaluation this job is about. Null once a queue exists that is about something else. */
    traceId: text('trace_id').references(() => traces.id, { onDelete: 'cascade' }),
    /** Carried from the request that enqueued the job, so its logs join to the request's (ADR-0010). */
    requestId: text('request_id').notNull(),
    status: jobAttemptStatus('status').notNull(),
    /** The failure's message on a failed attempt. Ours, never a raw provider or driver string. */
    error: text('error'),
    startedAt: timestampAt('started_at').notNull().defaultNow(),
    /** Null while the attempt is in flight, and null forever if the worker died. */
    finishedAt: timestampAt('finished_at'),
  },
  (table) => [
    // A natural composite key, and it is load-bearing rather than tidy: it is what makes
    // two concurrent deliveries of one job collide in Postgres instead of quietly writing
    // two rows that both claim to be attempt 3.
    primaryKey({ columns: [table.jobId, table.attempt] }),
    index('job_attempts_trace_idx').on(table.traceId),
    index('job_attempts_queue_started_idx').on(table.queue, table.startedAt),
  ],
)
