import type { JobQueue } from './queue.ts'
import {
  createRecordEvaluationHandler,
  RECORD_EVALUATION,
  type RecordEvaluationDeps,
} from './record-evaluation.ts'

/**
 * Where handlers meet queues. One call, so "which queues does this process work?" has an
 * answer you can read rather than one you have to grep for.
 *
 * Registration is separate from `createPgBossQueue` for the same reason `createApp(deps)`
 * is separate from `Bun.serve`: a test builds the queue it wants and registers the handler
 * it is testing, without the entrypoint's opinions about either.
 */

export const registerJobHandlers = async (
  queue: JobQueue,
  deps: RecordEvaluationDeps,
): Promise<void> => {
  await queue.work(RECORD_EVALUATION, createRecordEvaluationHandler(deps))
}

export type { JobDelivery, JobHandler, JobPayload, JobQueue } from './queue.ts'
export { createPgBossQueue } from './queue.ts'
export type { RecordEvaluationDeps } from './record-evaluation.ts'
export { createRecordEvaluationHandler, RECORD_EVALUATION } from './record-evaluation.ts'
