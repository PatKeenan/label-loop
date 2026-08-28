import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { and, eq, sql } from 'drizzle-orm'

/**
 * The attempt ledger's two writes. CONVENTIONS.md requires jobs to record their attempts
 * in the database, and ADR-0017 requires the record to be OURS — nothing here reads
 * pg-boss's tables to find out how many times a job has run.
 */

export type OpenAttempt = {
  jobId: string
  queue: string
  traceId: string
  requestId: string
  startedAt: Date
}

/**
 * Open an attempt and return its number.
 *
 * The counter is computed inside the INSERT rather than read first and written second. A
 * read-then-write would let two concurrent deliveries of one job both see attempt 2 and
 * both write it; here they contend on the composite primary key instead, so one succeeds
 * and the other is refused by Postgres. Concurrent delivery of a single job is not
 * something M0 produces — one worker, batch size one — but it is what an expired heartbeat
 * produces later, and the difference between the two designs is whether that day is a
 * rejected statement or a ledger quietly claiming two attempt 2s.
 */
export const openJobAttempt = async (db: Database, attempt: OpenAttempt): Promise<number> => {
  const rows = await db
    .insert(schema.jobAttempts)
    .values({
      jobId: attempt.jobId,
      queue: attempt.queue,
      traceId: attempt.traceId,
      requestId: attempt.requestId,
      status: 'started',
      startedAt: attempt.startedAt,
      attempt: sql<number>`(
        SELECT coalesce(max(${schema.jobAttempts.attempt}), 0) + 1
        FROM ${schema.jobAttempts}
        WHERE ${schema.jobAttempts.jobId} = ${attempt.jobId}
      )`,
    })
    .returning({ attempt: schema.jobAttempts.attempt })

  const row = rows[0]
  if (row === undefined) {
    throw new Error(`job attempt for ${attempt.jobId} was not recorded`)
  }
  return row.attempt
}

export type CloseAttempt = {
  jobId: string
  attempt: number
  status: 'completed' | 'failed'
  finishedAt: Date
  /** Our message, never a raw driver or provider string (CONVENTIONS.md "Error handling"). */
  error?: string
}

export const closeJobAttempt = async (db: Database, close: CloseAttempt): Promise<void> => {
  await db
    .update(schema.jobAttempts)
    .set({
      status: close.status,
      finishedAt: close.finishedAt,
      error: close.error ?? null,
    })
    .where(
      and(eq(schema.jobAttempts.jobId, close.jobId), eq(schema.jobAttempts.attempt, close.attempt)),
    )
}
