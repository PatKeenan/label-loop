import {
  assignAnnotatorsRequestSchema,
  createAnnotationSetRequestSchema,
  DICTATOR_REQUIRED,
  topUpAnnotationSetRequestSchema,
} from '@labelloop/contracts'
import { Hono, type MiddlewareHandler } from 'hono'
import { validator } from 'hono/validator'
import type { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { findPanelBySlug } from '../../repositories/panels.ts'
import { setProgress } from '../../services/annotation-queue.ts'
import {
  archiveAnnotationSet,
  assignAnnotators,
  createAnnotationSet,
  getAnnotationSetDetail,
  listAnnotationSets,
  topUpAnnotationSet,
} from '../../services/annotation-sets.ts'

/**
 * CURATING ANNOTATION SETS — the writes an engineer makes, and the list they read
 * (ADR-0079…0083, ADR-0086).
 *
 * **Every route is `annotation: ['curate']`**, which `admin` and `engineer` hold and an
 * annotator does not (ADR-0083). The split is not tidiness: assigning somebody a set grants
 * them read access to those traces through the annotate queue, in a panel they can otherwise
 * reach nothing of — so this is an access-granting surface, and it is guarded as one.
 *
 * Org-scoped from the SESSION, never from the request. Another org's panel or set is NOT_FOUND
 * — the same answer as one that does not exist (ADR-0057).
 *
 * There is NO route here that edits an answer, and there never will be. Nobody annotates
 * somebody else's work (ADR-0084); where a developer thinks an answer is wrong, the remedy is
 * another annotator on the set (ADR-0081).
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

const NO_SUCH_PANEL = 'No panel with that name is in this organisation.'
const NO_SUCH_SET = 'No annotation set with that id is in this organisation.'
const NAME_TAKEN = 'This panel already has an annotation set with that name.'
const ARCHIVED = 'This annotation set is archived. Archiving is where a pass stops changing.'
const AT_CAP = 'This annotation set is full. A set holds at most 250 traces.'

/**
 * Annotated `: () => never` rather than inferred. TypeScript narrows control flow through a
 * never-returning call only when the callee's type SAYS never at the declaration — an inferred
 * arrow does not qualify, and the caller is left checking `panel` again after a throw.
 */
const notFoundPanel: () => never = () => {
  throw new AppError('NOT_FOUND', NO_SUCH_PANEL, {
    context: { reason: 'panel is not in the active org' },
  })
}

const notFoundSet: () => never = () => {
  throw new AppError('NOT_FOUND', NO_SUCH_SET, {
    context: { reason: 'annotation set is not in the active org' },
  })
}

const unknownTraces: (traceIds: readonly string[]) => never = (traceIds) => {
  throw new AppError(
    'VALIDATION_ERROR',
    'Some of those traces are not in this panel. Nothing was added.',
    {
      issues: [
        {
          path: 'trace_ids',
          message: 'Some of those traces are not in this panel. Nothing was added.',
        },
      ],
      context: { count: traceIds.length },
    },
  )
}

export const createAnnotationSetRoutes = () =>
  new Hono<AppEnv>()
    /**
     * A panel's sets, newest first, ARCHIVED ONES INCLUDED. The filter is the console's, over
     * one list: an archive the server hides is a delete, and an archive always on screen is not
     * an archive.
     */
    .get(
      '/panels/:slug/annotation-sets',
      requirePermission({ annotation: ['curate'] }),
      async (c) => {
        const panel = await findPanelBySlug(c.var.deps.db, c.var.session.orgId, c.req.param('slug'))
        if (panel === undefined) notFoundPanel()
        const sets = await listAnnotationSets(c.var.deps.db, { panelId: panel.id })
        // DONE comes from `setProgress`, the same function the annotator's own list uses and
        // the set detail uses (ADR-0086). One definition, asked once for the whole page — a
        // per-row read would be one query per set, and a second definition would be worse.
        const progress = await setProgress(
          c.var.deps.db,
          sets.map((set) => set.id),
        )
        return c.json({
          data: {
            sets: sets.map((set) => ({
              id: set.id,
              name: set.name,
              size: set.size,
              done: progress.get(set.id)?.done ?? false,
              annotator_count: progress.get(set.id)?.annotators.length ?? 0,
              created_at: set.createdAt.toISOString(),
              created_by_email: set.createdByEmail,
              archived_at: set.archivedAt?.toISOString() ?? null,
            })),
          },
          request_id: c.var.requestId,
        })
      },
    )
    /**
     * ONE SET: who is assigned, where each of them is, and what each of them selected on every
     * trace (ADR-0084). There is NO write beside it that touches an answer, and there never
     * will be — nobody annotates somebody else's work.
     *
     * This is the one place ADR-0067's withholding does not apply. That ADR is about what
     * reaches the ANNOTATOR; reading a panel's traces is `trace: ['read']` territory, which
     * staff have and annotators do not.
     */
    .get('/annotation-sets/:id', requirePermission({ annotation: ['curate'] }), async (c) => {
      const detail = await getAnnotationSetDetail(c.var.deps.db, {
        orgId: c.var.session.orgId,
        setId: c.req.param('id'),
      })
      if (detail === undefined) notFoundSet()
      return c.json({
        data: {
          id: detail.id,
          name: detail.name,
          panel_slug: detail.panelSlug,
          size: detail.size,
          done: detail.done,
          created_at: detail.createdAt.toISOString(),
          created_by_email: detail.createdByEmail,
          archived_at: detail.archivedAt?.toISOString() ?? null,
          annotators: detail.annotators.map((annotator) => ({
            user_id: annotator.userId,
            email: annotator.email,
            name: annotator.name,
            is_dictator: annotator.isDictator,
            assigned_at: annotator.assignedAt.toISOString(),
            unassigned_at: annotator.unassignedAt?.toISOString() ?? null,
            answered: annotator.answered,
            annotated: annotator.annotated,
          })),
          traces: detail.traces.map((trace) => ({
            trace_id: trace.traceId,
            added_at: trace.addedAt.toISOString(),
            strategy: trace.strategy,
            counting: trace.counting,
            answers: trace.answers.map((answer) => ({
              annotator_id: answer.annotatorId,
              outcome: answer.outcome,
              note: answer.note,
              created_at: answer.createdAt.toISOString(),
              revisions: answer.revisions,
            })),
          })),
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * Create one, resolving its picker ONCE (ADR-0080). The set arrives with its traces or not
     * at all — one transaction — because a named set holding nothing is a thing somebody would
     * have to notice and fix.
     */
    .post(
      '/panels/:slug/annotation-sets',
      requirePermission({ annotation: ['curate'] }),
      wellFormedJson,
      jsonBody(createAnnotationSetRequestSchema),
      async (c) => {
        const body = c.req.valid('json')
        const panel = await findPanelBySlug(c.var.deps.db, c.var.session.orgId, c.req.param('slug'))
        if (panel === undefined) notFoundPanel()

        const { name, ...pick } = body
        const result = await createAnnotationSet({
          db: c.var.deps.db,
          clock: c.var.deps.clock,
          orgId: c.var.session.orgId,
          actorId: c.var.session.userId,
          requestId: c.var.requestId,
          panelId: panel.id,
          name,
          pick,
        })
        if (!result.ok) {
          if (result.kind === 'unknown_traces') unknownTraces(result.traceIds)
          throw new AppError('VALIDATION_ERROR', NAME_TAKEN, {
            issues: [{ path: 'name', message: NAME_TAKEN }],
          })
        }
        return c.json(
          { data: { id: result.setId, size: result.added }, request_id: c.var.requestId },
          201,
        )
      },
    )
    /** Run a picker again and APPEND. The cap is checked against what the set already holds. */
    .post(
      '/annotation-sets/:id/top-up',
      requirePermission({ annotation: ['curate'] }),
      wellFormedJson,
      jsonBody(topUpAnnotationSetRequestSchema),
      async (c) => {
        const result = await topUpAnnotationSet({
          db: c.var.deps.db,
          clock: c.var.deps.clock,
          orgId: c.var.session.orgId,
          actorId: c.var.session.userId,
          requestId: c.var.requestId,
          setId: c.req.param('id'),
          pick: c.req.valid('json'),
        })
        if (!result.ok) {
          if (result.kind === 'not_found') notFoundSet()
          if (result.kind === 'unknown_traces') unknownTraces(result.traceIds)
          const message = result.kind === 'archived' ? ARCHIVED : AT_CAP
          throw new AppError('VALIDATION_ERROR', message, {
            issues: [{ path: '', message }],
          })
        }
        return c.json({
          data: { added: result.added, size: result.size },
          request_id: c.var.requestId,
        })
      },
    )
    /**
     * WHO IS ASSIGNED, declared in full. Unassigning is a stamp; their answers stay and stay
     * visible (ADR-0086). Two or more assigned with no dictator is refused in both directions —
     * naming none, and unassigning the one there is (ADR-0081, open question 6).
     */
    .put(
      '/annotation-sets/:id/annotators',
      requirePermission({ annotation: ['curate'] }),
      wellFormedJson,
      jsonBody(assignAnnotatorsRequestSchema),
      async (c) => {
        const body = c.req.valid('json')
        const result = await assignAnnotators({
          db: c.var.deps.db,
          clock: c.var.deps.clock,
          orgId: c.var.session.orgId,
          actorId: c.var.session.userId,
          requestId: c.var.requestId,
          setId: c.req.param('id'),
          annotators: body.annotators.map((annotator) => ({
            userId: annotator.user_id,
            isDictator: annotator.is_dictator,
          })),
        })
        if (!result.ok) {
          if (result.kind === 'not_found') notFoundSet()
          if (result.kind === 'dictator_required') {
            throw new AppError('VALIDATION_ERROR', DICTATOR_REQUIRED, {
              issues: [{ path: 'annotators', message: DICTATOR_REQUIRED }],
            })
          }
          if (result.kind === 'archived') {
            throw new AppError('VALIDATION_ERROR', ARCHIVED, {
              issues: [{ path: '', message: ARCHIVED }],
            })
          }
          // A person who is not a member of this org, or is one who cannot annotate. The same
          // answer either way: the caller may not learn which, and neither can be assigned.
          const message = 'Some of those people cannot be assigned work in this organisation.'
          throw new AppError('VALIDATION_ERROR', message, {
            issues: [{ path: 'annotators', message }],
            context: { count: result.userIds.length },
          })
        }
        return c.json({
          data: {
            assigned: result.assigned,
            unassigned: result.unassigned,
            dictator_id: result.dictatorId,
          },
          request_id: c.var.requestId,
        })
      },
    )
    /**
     * A PERSON puts the set away (ADR-0086). It says nothing about whether the set is done —
     * done is derived, and archiving a half-finished pass is how one is abandoned.
     */
    .post(
      '/annotation-sets/:id/archive',
      requirePermission({ annotation: ['curate'] }),
      async (c) => {
        const result = await archiveAnnotationSet({
          db: c.var.deps.db,
          clock: c.var.deps.clock,
          orgId: c.var.session.orgId,
          actorId: c.var.session.userId,
          requestId: c.var.requestId,
          setId: c.req.param('id'),
        })
        if (!result.ok) notFoundSet()
        return c.json({
          data: { archived_at: result.archivedAt.toISOString() },
          request_id: c.var.requestId,
        })
      },
    )
