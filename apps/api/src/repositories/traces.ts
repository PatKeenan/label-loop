import type { VerdictStatus } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'

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
  /** Both null for a COLLECTING panel — no judges, so no verdict and no score (ADR-0060). */
  passed: boolean | null
  score: number | null
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
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
  /**
   * A decimal STRING, not a number. `numeric` is arbitrary-precision in Postgres and the
   * driver hands it back as text for exactly that reason; parsing it into a float here
   * would throw away the precision the column type was chosen to keep (ADR-0027).
   */
  costUsd: string | null
  costPriced: boolean
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
 * A detail view would fetch those by id, for the one trace being looked at — it is
 * UNSCHEDULED (`docs/PARKING_LOT.md`), not M4's, and the read does not exist yet.
 */
export type TraceListItem = {
  id: string
  panelId: string
  /**
   * The key's NAME, joined here rather than resolved client-side.
   *
   * A table of `key_01M2…` is a table nobody can scan. The alternative — the console fetching
   * keys and joining them in the browser — is an extra round trip to rebuild a join the
   * database already does, and it breaks the moment the list is paginated past what that
   * endpoint returns. (The panel's name and slug were joined the same way until phase 8
   * scoped the list to one panel, when every row would have repeated the page's heading.)
   *
   * `keyName` is nullable because `api_key_id` is: a trace OUTLIVES the key that made it
   * (`on delete set null`), since losing the evaluation record to a key's removal would be
   * the worse failure. The console renders that as a revoked-and-removed credential rather
   * than as a blank.
   */
  keyName: string | null
  /** Null when the panel was COLLECTING: it convened no judges (ADR-0060). */
  passed: boolean | null
  score: number | null
  complete: boolean
  threshold: number
  /** Null until the follow-up job has run; the console shows it as "pending". */
  recordedAt: Date | null
  createdAt: Date
  /**
   * `created_at` as POSTGRES renders it — microseconds included — for the pagination cursor
   * only. A JavaScript `Date` keeps milliseconds, so a cursor built from `createdAt` would sit
   * up to 999µs away from the row it names, and traces written within the same millisecond as
   * a page boundary would be skipped or repeated.
   */
  createdAtExact: string
}

/** Where the previous page ended: the `(created_at, id)` of its last row. */
export type TraceCursor = { createdAt: string; id: string }

/**
 * The console's trace list, newest first, for ONE panel in ONE org.
 *
 * `orgId` is a required parameter rather than an optional filter, which is the whole point:
 * there is no way to call this function that reads across tenants, so the tenancy rule is
 * enforced by the signature instead of by remembering to add a `where`. The middleware that
 * resolves the org is the only thing that supplies it.
 *
 * `panelId` narrows WITHIN the org and never replaces it: a panel id from another org matches
 * no row here, because both conditions apply.
 */
export const listTraces = async (
  db: Database,
  {
    orgId,
    panelId,
    limit,
    before,
  }: { orgId: string; panelId: string; limit: number; before?: TraceCursor | undefined },
): Promise<TraceListItem[]> =>
  db
    .select({
      id: schema.traces.id,
      panelId: schema.traces.panelId,
      keyName: schema.apiKeys.name,
      passed: schema.traces.passed,
      score: schema.traces.score,
      complete: schema.traces.complete,
      threshold: schema.traces.threshold,
      recordedAt: schema.traces.recordedAt,
      createdAt: schema.traces.createdAt,
      // QUALIFIED by hand: a column inside a `sql` template renders unqualified, and
      // `api_keys` has a `created_at` too (the trap Deviation 60 fell into, in a subquery).
      createdAtExact: sql<string>`"traces"."created_at"::text`,
    })
    .from(schema.traces)
    // LEFT on the key, which can be null: the trace outlives the credential that made it.
    .leftJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.traces.apiKeyId))
    .where(
      and(
        eq(schema.traces.orgId, orgId),
        eq(schema.traces.panelId, panelId),
        // KEYSET, not OFFSET. Traces arrive at the top continuously, so "skip the first 50"
        // names a different 50 every time someone sends a call — a page read twice would show
        // duplicates, or miss rows. "Older than the last row I saw" names the same rows
        // however many arrive meanwhile. The row comparison breaks ties on `id`, because
        // `created_at` alone is not unique.
        before === undefined
          ? undefined
          : sql`("traces"."created_at", "traces"."id") < (${before.createdAt}::timestamptz, ${before.id})`,
      ),
    )
    // Matches `traces_panel_created_idx` for the leading column, so the list stays an index
    // scan as the table grows; `id` only orders ties.
    .orderBy(desc(schema.traces.createdAt), desc(schema.traces.id))
    .limit(limit)
