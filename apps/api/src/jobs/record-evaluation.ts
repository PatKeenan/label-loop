import type { Database, QueueName } from '@labelloop/db'
import type { RootLogger } from '../middleware/logger.ts'
import type { Clock } from '../ports/clock.ts'
import type { ErrorReporter } from '../ports/error-reporter.ts'
import { closeJobAttempt, openJobAttempt } from '../repositories/job-attempts.ts'
import { markTraceRecorded } from '../repositories/traces.ts'
import type { JobHandler } from './queue.ts'

/**
 * The follow-up to one evaluation, run off the request path.
 *
 * **What it does today, honestly.** It stamps the trace as having had its follow-up run.
 * Nothing at M0 genuinely needs to be asynchronous — the judging is the request, and the
 * trace is written inside it because ADR-0001 says 100% of calls are captured. What M0
 * needs is the SEAM, wired the way the work that arrives later will need it: metering
 * rollups at M2, annotation sampling at M5, drift checks at M4. Each of those is a line
 * added here rather than a queue introduced then.
 *
 * **What makes it a real proof rather than a placeholder** is that its one effect is
 * conditional on its own absence, so re-delivery is a no-op enforced by Postgres, and that
 * every delivery leaves a row in a ledger we own (ADR-0017). Those two properties are the
 * ones that are painful to retrofit onto a handler written without them.
 */

export const RECORD_EVALUATION: QueueName = 'record-evaluation'

export type RecordEvaluationDeps = {
  db: Database
  clock: Clock
  errorReporter: ErrorReporter
  /** The ROOT logger: a job has no request context, so it makes its own child. */
  logger: RootLogger
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

export const createRecordEvaluationHandler = (deps: RecordEvaluationDeps): JobHandler => {
  return async ({ jobId, queue, payload }) => {
    // The bindings that make a job's lines findable: `request_id` joins them to the request
    // that enqueued the job, `trace_id` to the evaluation they are about (ADR-0010).
    const logger = deps.logger.child({
      queue,
      job_id: jobId,
      request_id: payload.request_id,
      trace_id: payload.trace_id,
    })

    // Outside the try below, because a failure here means there is no attempt row to close
    // — the ledger cannot record an attempt at a job whose trace does not exist, and the
    // foreign key is what says so.
    const attempt = await openJobAttempt(deps.db, {
      jobId,
      queue,
      traceId: payload.trace_id,
      requestId: payload.request_id,
      startedAt: new Date(deps.clock.now()),
    }).catch((error: unknown) => {
      logger.error({ err: error }, 'job attempt could not be recorded')
      deps.errorReporter.report(error, {
        requestId: payload.request_id,
        context: { queue, job_id: jobId, trace_id: payload.trace_id },
      })
      throw error
    })

    logger.info({ attempt }, 'job started')

    try {
      const recorded = await markTraceRecorded(
        deps.db,
        payload.trace_id,
        new Date(deps.clock.now()),
      )
      await closeJobAttempt(deps.db, {
        jobId,
        attempt,
        status: 'completed',
        finishedAt: new Date(deps.clock.now()),
      })
      // `recorded: false` is the successful idempotent case, not a warning — this is a
      // re-delivery of a job whose work is already done, and the queue is entitled to do
      // that. It is logged rather than silent so a run of them is visible.
      logger.info({ attempt, recorded }, 'job finished')
    } catch (error) {
      // The ledger lives in the same database as the work, so whatever broke the work can
      // break this write too. It must not be allowed to REPLACE the original error: a
      // caller told "could not close the attempt" learns nothing about why the job failed,
      // and the report below would never be made. So it is logged and swallowed, and the
      // cause is what propagates.
      await closeJobAttempt(deps.db, {
        jobId,
        attempt,
        status: 'failed',
        finishedAt: new Date(deps.clock.now()),
        error: messageOf(error),
      }).catch((closeError: unknown) => {
        logger.error({ attempt, err: closeError }, 'job attempt could not be closed')
      })
      logger.error({ attempt, err: error }, 'job failed')
      // Reporting is not handling (ADR-0007). The throw below is the handling: it hands the
      // job back to the queue, which is what a retry is.
      deps.errorReporter.report(error, {
        requestId: payload.request_id,
        context: { queue, job_id: jobId, attempt, trace_id: payload.trace_id },
      })
      throw error
    }
  }
}
