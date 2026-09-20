import { annotationRequestSchema } from '@labelloop/contracts'
import { Hono, type MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'
import type { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { listReviewPanels, nextItem, recordAnnotation } from '../../services/annotation-queue.ts'

/**
 * THE REVIEW SURFACE — what an annotator is served, and what they send back (ADR-0066).
 *
 * **Every route is `annotation: [create]`**, which is the only capability an annotator holds
 * (ADR-0064). Staff hold it too: a role says what you may DO, and which surface you land on is
 * a preference, so an engineer who wants to annotate may.
 *
 * **What is NOT in these responses is the design** (ADR-0067). No verdict, score, confidence,
 * model, cost, key — and no trace id. An item is addressed by an opaque `item_id`, so a
 * screen cannot deep-link an annotator into the console's trace detail, and the payload cannot
 * leak what it never carries. `metadata` is withheld as well (ADR-0077): it is bookkeeping and
 * may hold a customer id. The tests assert the payload's KEYS, not just its values, because
 * the guarantee is about absence.
 *
 * `item_id` IS the trace id today. That is an implementation detail on purpose: it is never
 * labelled as one, never rendered, and the write resolves it under the session's org, so
 * knowing the value buys nothing a session did not already grant.
 */

/** As `members.ts`: Hono's validator, so the body's TYPE reaches the console over RPC. */
const jsonBody = <T>(schema: z.ZodType<T>) =>
  validator('json', (value): T => {
    const body = schema.safeParse(value)
    if (body.success) return body.data
    throw new AppError('VALIDATION_ERROR', 'The request body failed validation.', {
      issues: body.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    })
  })

/** Same reason as `members.ts`: a body that is not JSON is a 422 here, not an INTERNAL. */
const wellFormedJson: MiddlewareHandler<AppEnv> = async (c, next) => {
  const parsed = await c.req.json().then(
    () => true,
    () => false,
  )
  if (!parsed) {
    throw new AppError('VALIDATION_ERROR', 'The request body must be JSON.', {
      issues: [{ path: '', message: 'The request body must be JSON.' }],
    })
  }
  await next()
}

const NO_SUCH_PANEL = 'No panel with that name is available to review.'
const NO_SUCH_ITEM = 'That item is no longer available to review.'

export const createReviewRoutes = () =>
  new Hono<AppEnv>()
    /**
     * Every panel in the org with this annotator's standing in it: how many traces it has
     * collected, whether the gate is open, and how many are left for them. A LOCKED panel is
     * listed rather than hidden — the r6 mockup's landing shows progress toward 50 for each,
     * because a gate with no visible distance is indistinguishable from a dead end.
     */
    .get('/review/panels', requirePermission({ annotation: ['create'] }), async (c) => {
      const panels = await listReviewPanels(c.var.deps.db, {
        orgId: c.var.session.orgId,
        annotatorId: c.var.session.userId,
      })
      return c.json({
        data: {
          panels: panels.map((panel) => ({
            slug: panel.slug,
            name: panel.name,
            trace_count: panel.traceCount,
            open: panel.open,
            remaining: panel.remaining,
            reviewed: panel.reviewed,
          })),
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * ONE ITEM, or why there is none. Three states, named rather than inferred from an empty
     * body: `locked` (below the floor, with the count so the surface can draw progress),
     * `drained` (nothing left for this person), and `item`.
     *
     * `input` is null on a trace recorded before the four roles existed (ADR-0074). It is
     * still served: the question is whether the OUTPUT is acceptable, and the surface says the
     * input was never captured rather than drawing an empty block.
     */
    .get('/review/panels/:slug/next', requirePermission({ annotation: ['create'] }), async (c) => {
      const result = await nextItem(c.var.deps.db, {
        orgId: c.var.session.orgId,
        panelSlug: c.req.param('slug'),
        annotatorId: c.var.session.userId,
      })
      if (result === null) {
        throw new AppError('NOT_FOUND', NO_SUCH_PANEL, {
          context: { reason: 'panel is not in the active org' },
        })
      }
      if (result.state === 'locked') {
        return c.json({
          data: { state: 'locked' as const, trace_count: result.traceCount },
          request_id: c.var.requestId,
        })
      }
      if (result.state === 'drained') {
        return c.json({ data: { state: 'drained' as const }, request_id: c.var.requestId })
      }
      return c.json({
        data: {
          state: 'item' as const,
          item_id: result.item.traceId,
          // The three roles an annotator reads. `metadata` is absent by construction.
          input: result.item.input,
          output: result.item.output,
          reference: result.item.reference,
          remaining: result.item.remaining,
          // Reviewed by this person in this panel, EVER (not this visit): the count was local
          // state and reset to zero on every return, which read as work having been lost.
          reviewed: result.item.reviewed,
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * The answer. Append-only: this always INSERTS, including when the same person answers the
     * same trace twice — a changed mind is a new row, and the sequence is the evidence.
     */
    .post(
      '/review/annotations',
      requirePermission({ annotation: ['create'] }),
      wellFormedJson,
      jsonBody(annotationRequestSchema),
      async (c) => {
        const body = c.req.valid('json')
        const result = await recordAnnotation(c.var.deps.db, {
          orgId: c.var.session.orgId,
          annotatorId: c.var.session.userId,
          requestId: c.var.requestId,
          traceId: body.item_id,
          outcome: body.outcome,
          note: body.note,
        })
        if (!result.ok) {
          // A trace in another org, or one that has been removed: the same answer either way.
          throw new AppError('NOT_FOUND', NO_SUCH_ITEM, {
            context: { reason: 'item is not in the active org' },
          })
        }
        return c.json(
          { data: { id: result.annotationId, outcome: body.outcome }, request_id: c.var.requestId },
          201,
        )
      },
    )
