import type { QueueName } from '@labelloop/db'
import type { JobHandler, JobPayload, JobQueue } from '../jobs/index.ts'

/**
 * A queue stand-in for the tests that are not about the queue.
 *
 * Same reasoning as `fake-database.ts`: most of the API's tests are about routing, the
 * envelope and the evaluation path, and making them start pg-boss would make them slow and
 * flaky for reasons unrelated to what they assert. The tests that ARE about the queue —
 * that a job round-trips, that a re-delivery is a no-op — run against real Postgres.
 *
 * It records what was sent rather than delivering it, so a test can assert "exactly one
 * job, carrying these two ids" without waiting on a poller.
 */

export type SentJob = { queue: QueueName; payload: JobPayload }

export type FakeQueueOptions = {
  /** Fail every `send`, as an unreachable Postgres would. */
  sendFails?: Error
  /** Fail `check()`, so `/readyz` reports the queue as the failing dependency. */
  unhealthy?: Error
}

export type FakeQueue = JobQueue & {
  readonly sent: readonly SentJob[]
  readonly handlers: ReadonlyMap<QueueName, JobHandler>
  readonly stopped: () => boolean
}

export const fakeQueue = ({ sendFails, unhealthy }: FakeQueueOptions = {}): FakeQueue => {
  const sent: SentJob[] = []
  const handlers = new Map<QueueName, JobHandler>()
  let stopped = false

  return {
    sent,
    handlers,
    stopped: () => stopped,
    start: async () => {},
    stop: async () => {
      stopped = true
    },
    send: async (queue, payload) => {
      if (sendFails !== undefined) throw sendFails
      sent.push({ queue, payload })
      return `job_${sent.length}`
    },
    work: async (queue, handler) => {
      handlers.set(queue, handler)
    },
    check: async () => {
      if (unhealthy !== undefined) throw unhealthy
    },
  }
}
