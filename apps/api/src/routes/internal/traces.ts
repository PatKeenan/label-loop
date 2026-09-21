import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import {
  getTraceDetail,
  listTraces,
  type TraceCursor,
  type TraceListItem,
} from '../../repositories/traces.ts'

/**
 * `GET /internal/traces` — the console's trace list, and the read half of the loop P4
 * writes. Every row here was produced by a real evaluation through `/v1`; nothing in the
 * console can create one.
 */

/**
 * A ceiling, not a suggestion. Without one, `?limit=100000` is a request a caller can make
 * that costs us a full table read, which is the cheapest denial of service there is.
 */
const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50

/**
 * `panel_id` is REQUIRED, not an optional filter (M4 phase 8).
 *
 * The list was org-wide through phase 7, which CONSOLE_FLOW §4 called the easy way round:
 * narrowing a read later breaks nobody, widening one does. Phase 8 narrows it. Traces is a
 * section INSIDE a panel (ADR-0062 — there is no sidebar, and so no Traces, anywhere else),
 * so no screen asks for an org's traces, and an optional parameter would keep a read alive
 * that nothing uses and every future caller could forget to narrow. Relaxing it back to
 * optional is cheap if an org-wide view is ever designed; it has not been.
 *
 * An id rather than a slug because `traces` carries `panel_id` and `traces_panel_created_idx`
 * is on it, so the filter is an index scan with no join. The console has the id already, from
 * the same panel list that resolves the slug in its URL.
 */
const listQuerySchema = z.object({
  panel_id: z.string().startsWith('pnl_'),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  before: z.string().optional(),
})

/**
 * THE PAGINATION CURSOR — opaque to the caller, and that is a decision.
 *
 * It is the `(created_at, id)` of the last row of the previous page, base64url-encoded JSON.
 * Opaque so the console treats it as a token to hand back rather than something to build, which
 * keeps the ordering free to change without breaking a client that composed its own.
 *
 * `created_at` is Postgres's own text rendering (microseconds included) and is validated here
 * before it reaches a `::timestamptz` cast, so a tampered cursor is a 422 rather than a 500.
 */
const TIMESTAMP_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/
const cursorSchema = z.tuple([z.string().regex(TIMESTAMP_TEXT), z.string().startsWith('tr_')])

const encodeCursor = (row: TraceListItem): string =>
  Buffer.from(JSON.stringify([row.createdAtExact, row.id])).toString('base64url')

const decodeCursor = (value: string): TraceCursor | undefined => {
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    )
    return parsed.success ? { createdAt: parsed.data[0], id: parsed.data[1] } : undefined
  } catch {
    return undefined
  }
}

/**
 * Both reads are `trace: [read]` — staff only (ADR-0068). The list was left open through M4
 * (Deviation 32); an annotator now reads traces only through their review queue, which serves
 * the trace's roles and nothing an operator sees.
 */
export const createTraceRoutes = () =>
  new Hono<AppEnv>()
    .get('/traces', requirePermission({ trace: ['read'] }), async (c) => {
      const query = listQuerySchema.safeParse({
        panel_id: c.req.query('panel_id'),
        ...(c.req.query('before') === undefined ? {} : { before: c.req.query('before') }),
        // `undefined` rather than the raw value when absent, so the schema's default applies
        // instead of Zod being asked to coerce a missing string.
        ...(c.req.query('limit') === undefined ? {} : { limit: c.req.query('limit') }),
      })
      if (!query.success) {
        // Thrown, never built here: one handler owns serialization (CONVENTIONS.md).
        throw new AppError('VALIDATION_ERROR', 'The query string failed validation.', {
          issues: query.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        })
      }

      // The org comes from the session, never from the request. A `?org_id=` parameter is how
      // a console grows a tenancy bug.
      //
      // The panel DOES come from the request, and is safe to: the org filter still applies, so
      // another org's panel id answers an empty list — the same answer as a real panel with no
      // traffic yet, which is what keeps it from confirming that panel exists (ADR-0057).
      const before = query.data.before === undefined ? undefined : decodeCursor(query.data.before)
      if (query.data.before !== undefined && before === undefined) {
        throw new AppError('VALIDATION_ERROR', 'The query string failed validation.', {
          issues: [{ path: 'before', message: 'is not a cursor this API issued' }],
        })
      }

      // ONE extra row, to learn whether an older page exists without a COUNT(*) over the panel —
      // which would be the one part of this read that grows with the table.
      const rows = await listTraces(c.var.deps.db, {
        orgId: c.var.session.orgId,
        panelId: query.data.panel_id,
        limit: query.data.limit + 1,
        before,
      })
      const traces = rows.slice(0, query.data.limit)
      const last = traces.at(-1)
      const nextCursor =
        rows.length > query.data.limit && last !== undefined ? encodeCursor(last) : null

      return c.json({
        data: {
          traces: traces.map((trace) => ({
            id: trace.id,
            panel_id: trace.panelId,
            // Null when the key has been deleted outright. A revoked key still has its row and
            // therefore still has its name — this is the harder case, where the credential is
            // gone and the trace it authorised remains.
            key_name: trace.keyName,
            // Null for a trace captured while the panel was COLLECTING: it convened no
            // judges, so there is no verdict and no score (ADR-0060).
            passed: trace.passed,
            score: trace.score,
            complete: trace.complete,
            threshold: trace.threshold,
            // Whether somebody has answered it (M5 phase 6) — a boolean, not a count. What
            // the table shows is that a human has been here; WHO and what they said is the
            // detail read, which is one trace's worth of rows rather than a page's.
            annotated: trace.annotated,
            recorded_at: trace.recordedAt?.toISOString() ?? null,
            created_at: trace.createdAt.toISOString(),
          })),
          // Hand this back as `before` for the next-older page; null when there is none.
          next_cursor: nextCursor,
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * ONE trace, whole: what the caller's agent sent, and what each judge said about it — the
     * console's trace drawer (Deviation 75).
     *
     * **Staff only** (`trace: [read]`), like the list since M5 closed Deviation 32. This read
     * carries the customer's own production data in its four roles, and each judge's rationale and
     * confidence — none of which reaches an annotator (ADR-0067), who reads traces only through
     * their queue.
     *
     * A trace in another org is NOT_FOUND, never FORBIDDEN (ADR-0057).
     *
     * **Not audited**, and that is a known gap rather than an oversight: reading a customer's
     * output is a candidate audit event, and M8 owns the audit log's vocabulary and viewer.
     */
    .get('/traces/:id', requirePermission({ trace: ['read'] }), async (c) => {
      const trace = await getTraceDetail(c.var.deps.db, {
        orgId: c.var.session.orgId,
        traceId: c.req.param('id'),
      })
      if (trace === null) {
        throw new AppError('NOT_FOUND', 'No trace with that id is available to this account.')
      }

      return c.json({
        data: {
          id: trace.id,
          panel_id: trace.panelId,
          panel_version_id: trace.panelVersionId,
          panel_version: trace.panelVersion,
          key_name: trace.keyName,
          // The W3C id of the HTTP execution, so a person can find this call's spans (ADR-0010).
          request_id: trace.requestId,
          // The four roles (ADR-0073). `input` is null on a LEGACY row, which never recorded
          // one; `output` is never null in practice — migration 0013 backfilled every row.
          //
          // Widened to `unknown` on the way out, deliberately. The console consumes this through
          // Hono's RPC type inference, and a RECURSIVE `JsonValue` pushed through it exceeds
          // TypeScript's instantiation depth (TS2589) at every use site. Nothing is lost: the
          // console renders by SHAPE, narrowing at runtime, which is what an `unknown` asks for.
          input: trace.input as unknown,
          output: trace.output as unknown,
          reference: trace.reference as Record<string, unknown> | null,
          metadata: trace.metadata,
          // Null while COLLECTING (ADR-0060) — and then `judges` is empty, because none ran.
          passed: trace.passed,
          score: trace.score,
          complete: trace.complete,
          threshold: trace.threshold,
          recorded_at: trace.recordedAt?.toISOString() ?? null,
          created_at: trace.createdAt.toISOString(),
          judges: trace.verdicts.map((verdict) => ({
            slug: verdict.judgeSlug,
            name: verdict.judgeName,
            version: verdict.judgeVersion,
            question: verdict.question,
            polarity: verdict.polarity,
            status: verdict.status,
            verdict: verdict.verdict,
            passed: verdict.passed,
            rationale: verdict.rationale,
            reasons: verdict.reasons,
            confidence: verdict.confidence,
            weight: verdict.weight,
            served_by: verdict.servedBy,
            latency_ms: verdict.latencyMs,
            attempts: verdict.attempts,
            input_tokens: verdict.inputTokens,
            output_tokens: verdict.outputTokens,
            reasoning_tokens: verdict.reasoningTokens,
            // A decimal STRING (ADR-0027) — never parsed into a float on the way out.
            cost_usd: verdict.costUsd,
            cost_priced: verdict.costPriced,
          })),
          /**
           * WHAT PEOPLE SAID (M5 phase 6) — one entry per annotator, their latest answer,
           * newest first. Empty when nobody has looked at it yet.
           *
           * The NOTE crosses the wire here and never reaches the audit log, which is the
           * opposite of how the two are usually weighted and is deliberate (ADR-0066): a
           * note is free text an annotator may have put a customer's words in, so it lives
           * in a table an erasure request can reach rather than in an append-only log.
           */
          annotations: trace.annotations.map((annotation) => ({
            id: annotation.id,
            annotator_id: annotation.annotatorId,
            annotator_name: annotation.annotatorName,
            annotator_email: annotation.annotatorEmail,
            outcome: annotation.outcome,
            note: annotation.note,
            // How many EARLIER answers this person gave on this trace. Zero normally; above
            // zero is a changed mind, and the screen says so rather than hiding the first.
            revisions: annotation.revisions,
            created_at: annotation.createdAt.toISOString(),
          })),
        },
        request_id: c.var.requestId,
      })
    })
