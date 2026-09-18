import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { listTraces } from '../../repositories/traces.ts'

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
})

export const createTraceRoutes = () =>
  new Hono<AppEnv>().get('/traces', async (c) => {
    const query = listQuerySchema.safeParse({
      panel_id: c.req.query('panel_id'),
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
    const traces = await listTraces(c.var.deps.db, {
      orgId: c.var.session.orgId,
      panelId: query.data.panel_id,
      limit: query.data.limit,
    })

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
          recorded_at: trace.recordedAt?.toISOString() ?? null,
          created_at: trace.createdAt.toISOString(),
        })),
      },
      request_id: c.var.requestId,
    })
  })
