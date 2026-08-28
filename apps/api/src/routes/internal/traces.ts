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

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
})

export const createTraceRoutes = () =>
  new Hono<AppEnv>().get('/traces', async (c) => {
    const query = listQuerySchema.safeParse({
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
    const traces = await listTraces(c.var.deps.db, c.var.session.orgId, query.data.limit)

    return c.json({
      data: {
        traces: traces.map((trace) => ({
          id: trace.id,
          panel_id: trace.panelId,
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
