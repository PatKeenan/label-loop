import type { VerdictStatus } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { and, desc, eq, isNull } from 'drizzle-orm'

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

/**
 * Stamp the trace as having had its asynchronous follow-up run, and say whether this call
 * is the one that did it.
 *
 * `WHERE recorded_at IS NULL` is the entire idempotency mechanism (CONVENTIONS.md "Async &
 * jobs"). A re-delivered job updates zero rows and gets `false` back, so the second
 * delivery is a no-op because POSTGRES made it one — not because the handler read a flag
 * and then decided, which is the version with a race in it.
 */
export const markTraceRecorded = async (
  db: Database,
  traceId: string,
  recordedAt: Date,
): Promise<boolean> => {
  const rows = await db
    .update(schema.traces)
    .set({ recordedAt })
    .where(and(eq(schema.traces.id, traceId), isNull(schema.traces.recordedAt)))
    .returning({ id: schema.traces.id })
  return rows.length > 0
}

/**
 * One row of the console's trace list. Deliberately NOT the whole trace: the list renders
 * a table, and `artifact` is unbounded caller text while `context` is an arbitrary object,
 * so selecting them would put the largest two columns on the page that reads the most rows.
 * The detail view (M4) fetches those by id, for the one trace being looked at.
 */
export type TraceListItem = {
  id: string
  panelId: string
  passed: boolean
  score: number
  complete: boolean
  threshold: number
  /** Null until the follow-up job has run; the console shows it as "pending". */
  recordedAt: Date | null
  createdAt: Date
}

/**
 * The console's trace list, newest first, for ONE org.
 *
 * `orgId` is a required parameter rather than an optional filter, which is the whole point:
 * there is no way to call this function that reads across tenants, so the tenancy rule is
 * enforced by the signature instead of by remembering to add a `where`. The middleware that
 * resolves the org is the only thing that supplies it.
 */
export const listTraces = async (
  db: Database,
  orgId: string,
  limit: number,
): Promise<TraceListItem[]> =>
  db
    .select({
      id: schema.traces.id,
      panelId: schema.traces.panelId,
      passed: schema.traces.passed,
      score: schema.traces.score,
      complete: schema.traces.complete,
      threshold: schema.traces.threshold,
      recordedAt: schema.traces.recordedAt,
      createdAt: schema.traces.createdAt,
    })
    .from(schema.traces)
    .where(eq(schema.traces.orgId, orgId))
    // Matches `traces_org_created_idx`, so the list stays an index scan as the table grows.
    .orderBy(desc(schema.traces.createdAt))
    .limit(limit)
