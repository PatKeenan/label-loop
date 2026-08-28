import type { VerdictStatus } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'

/**
 * Writing the trace, which happens on 100% of evaluations because the judge call flows
 * through us (ADR-0001). It is not sampled, not best-effort, and not conditional on the
 * evaluation having succeeded — a run where every judge errored is exactly the run
 * somebody will want to look at later.
 */

export type TraceRow = {
  id: string
  orgId: string
  panelId: string
  panelVersionId: string
  /** The key that authorised the call. Nullable in the schema; never null in practice. */
  apiKeyId: string | null
  /** The W3C id of the HTTP execution, so a permanent row joins to its spans (ADR-0010). */
  requestId: string
  artifact: string
  context: Record<string, string> | null
  passed: boolean
  score: number
  complete: boolean
  threshold: number
}

export type TraceVerdictRow = {
  judgeVersionId: string
  status: VerdictStatus
  verdict: boolean | null
  passed: boolean | null
  rationale: string | null
  reasons: string[]
  confidence: number | null
  weight: number | null
  servedBy: string | null
  latencyMs: number
  attempts: number
  /** The provider's untouched payload, stored beside the normalised columns above. */
  rawResponse: unknown
}

/**
 * One trace and its verdicts, in a single transaction.
 *
 * The transaction is not ceremony. A trace with no verdicts reads as an evaluation where
 * no judge ran, which is a real state with a real meaning — so a half-written pair would
 * not look like corruption, it would look like a different outcome, and the annotation and
 * metering surfaces downstream would believe it.
 */
export const insertTrace = async (
  db: Database,
  trace: TraceRow,
  verdicts: TraceVerdictRow[],
): Promise<void> => {
  await db.transaction(async (tx) => {
    await tx.insert(schema.traces).values(trace)
    if (verdicts.length === 0) return
    await tx
      .insert(schema.traceVerdicts)
      .values(verdicts.map((verdict) => ({ ...verdict, traceId: trace.id })))
  })
}
