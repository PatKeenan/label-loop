import { annotationRequestSchema } from '@labelloop/contracts'
import { Hono, type MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'
import type { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import {
  listAssignedSets,
  nextItem,
  previousItem,
  recordAnnotation,
} from '../../services/annotation-queue.ts'

/**
 * THE ANNOTATOR SURFACE — what an annotator is served, and what they send back (ADR-0066,
 * ADR-0079).
 *
 * **Every route is `annotation: [create]`**, which is the only capability an annotator holds
 * (ADR-0064). Staff hold it too: a role says what you may DO, and a developer assigned a set
 * annotates it here like anybody else — deliberately, from their own list, never routed
 * (ADR-0084).
 *
 * **Work is an ASSIGNED SET, and a set you are not on is NOT_FOUND** (ADR-0079). There is no
 * panel-wide queue and no default set: an annotator with nothing assigned has nothing to do,
 * and the surface says so rather than inventing work.
 *
 * **What is NOT in these responses is the design** (ADR-0067). No verdict, score, confidence,
 * model, cost, key — and no trace id. An item is addressed by an opaque `item_id`, so a
 * screen cannot deep-link an annotator into the console's trace detail, and the payload cannot
 * leak what it never carries. `metadata` is withheld as well (ADR-0077): it is bookkeeping and
 * may hold a customer id. The set's NAME reaches the annotator; its STRATEGY does not, because
 * which picker chose a trace is an operator signal. The tests assert the payload's KEYS, not
 * just its values, because the guarantee is about absence.
 *
 * `item_id` IS the trace id today. That is an implementation detail on purpose: it is never
 * labelled as one, never rendered, and the write resolves it against the set's membership under
 * the session's org, so knowing the value buys nothing an assignment did not already grant.
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

/**
 * ONE SENTENCE FOR EVERY WAY A SET IS UNREACHABLE: not yours, archived, gone, or simply one you
 * are not assigned to. Distinguishing them would confirm that a set exists to somebody who was
 * not given it (ADR-0057, applied to work rather than to tenancy).
 */
const NO_SUCH_SET = 'That set is not assigned to you.'
const NO_SUCH_ITEM = 'That item is no longer available to annotate.'

export const createAnnotateRoutes = () =>
  new Hono<AppEnv>()
    /**
     * THE SETS ASSIGNED TO THIS PERSON. An empty list is the honest answer for somebody with
     * nothing assigned — the surface says so and offers nothing, rather than finding them work.
     *
     * A set whose panel is below the floor is listed rather than hidden, with the count, so the
     * gate has a visible distance: a gate with none is indistinguishable from a dead end.
     */
    .get('/annotate/sets', requirePermission({ annotation: ['create'] }), async (c) => {
      const sets = await listAssignedSets(c.var.deps.db, {
        orgId: c.var.session.orgId,
        annotatorId: c.var.session.userId,
      })
      return c.json({
        data: {
          sets: sets.map((set) => ({
            id: set.setId,
            name: set.name,
            panel_name: set.panelName,
            trace_count: set.traceCount,
            open: set.open,
            size: set.size,
            remaining: set.remaining,
            annotated: set.annotated,
          })),
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * ONE ITEM, or why there is none. Three states, named rather than inferred from an empty
     * body: `locked` (the panel is below the floor, with the count so the surface can draw
     * progress), `drained` (nothing left for this person IN THIS SET), and `item`.
     *
     * `input` is null on a trace recorded before the four roles existed (ADR-0074). It is
     * still served: the question is whether the OUTPUT is acceptable, and the surface says the
     * input was never captured rather than drawing an empty block.
     */
    .get('/annotate/sets/:id/next', requirePermission({ annotation: ['create'] }), async (c) => {
      const result = await nextItem(c.var.deps.db, {
        orgId: c.var.session.orgId,
        setId: c.req.param('id'),
        annotatorId: c.var.session.userId,
      })
      if (result === null) {
        throw new AppError('NOT_FOUND', NO_SUCH_SET, {
          context: { reason: 'set is not assigned to this person in the active org' },
        })
      }
      if (result.state === 'locked') {
        return c.json({
          data: { state: 'locked' as const, trace_count: result.traceCount },
          request_id: c.var.requestId,
        })
      }
      if (result.state === 'drained') {
        return c.json({
          data: { state: 'drained' as const, annotated: result.annotated },
          request_id: c.var.requestId,
        })
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
          // Annotated by this person in this set, EVER (not this visit): the count was local
          // state and reset to zero on every return, which read as work having been lost.
          annotated: result.item.annotated,
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * ONE STEP BACK: the last thing this person answered IN THIS SET, served again so a mis-key
     * is recoverable. `state: 'none'` when there is nothing behind them — the surface draws the
     * control only when there is.
     *
     * It carries `previous_outcome`, which is the ONE operator-ish signal on this surface and
     * is this person's OWN answer rather than a machine's (ADR-0067 withholds what a judge or
     * the platform thinks; it does not withhold what you yourself said a moment ago). It is
     * never anybody ELSE's answer — that anchor is what ADR-0081 keeps out of this surface.
     */
    .get(
      '/annotate/sets/:id/previous',
      requirePermission({ annotation: ['create'] }),
      async (c) => {
        const result = await previousItem(c.var.deps.db, {
          orgId: c.var.session.orgId,
          setId: c.req.param('id'),
          annotatorId: c.var.session.userId,
        })
        if (result === null) {
          return c.json({ data: { state: 'none' as const }, request_id: c.var.requestId })
        }
        return c.json({
          data: {
            state: 'item' as const,
            item_id: result.item.traceId,
            input: result.item.input,
            output: result.item.output,
            reference: result.item.reference,
            remaining: result.item.remaining,
            annotated: result.item.annotated,
            previous_outcome: result.previousOutcome,
          },
          request_id: c.var.requestId,
        })
      },
    )
    /**
     * The answer. Append-only: this always INSERTS, including when the same person answers the
     * same trace twice — a changed mind is a new row, and the sequence is the evidence.
     *
     * The SET is in the path rather than the body, matching the reads: the write is authorised
     * by the same membership row that serves the item, and that row also names the sampler.
     */
    .post(
      '/annotate/sets/:id/annotations',
      requirePermission({ annotation: ['create'] }),
      wellFormedJson,
      jsonBody(annotationRequestSchema),
      async (c) => {
        const body = c.req.valid('json')
        const result = await recordAnnotation(c.var.deps.db, {
          orgId: c.var.session.orgId,
          setId: c.req.param('id'),
          annotatorId: c.var.session.userId,
          requestId: c.var.requestId,
          traceId: body.item_id,
          outcome: body.outcome,
          note: body.note,
        })
        if (!result.ok) {
          // A trace outside this set, a set in another org, one that has been archived, or one
          // this person is not assigned to: the same answer for all of them.
          throw new AppError('NOT_FOUND', NO_SUCH_ITEM, {
            context: { reason: 'item is not in a set assigned to this person' },
          })
        }
        return c.json(
          { data: { id: result.annotationId, outcome: body.outcome }, request_id: c.var.requestId },
          201,
        )
      },
    )
