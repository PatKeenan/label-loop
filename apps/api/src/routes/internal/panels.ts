import { modelPinSchema } from '@labelloop/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requireRole } from '../../middleware/require-role.ts'
import { listPanels } from '../../repositories/panels.ts'
import { createPanel } from '../../services/create-panel.ts'

/**
 * `/internal/panels` — creating a panel with its judges, and listing an org's panels.
 *
 * **Creation is ONE submit carrying the whole panel**, not a panel followed by judges added
 * one at a time. That is not a style choice: a `pnv_` pins its judge set (ADR-0019), and both
 * version tables are immutable (migration 0005), so "add a judge to this panel" is not an
 * insert — it is writing panel version n+1. There is no draft row to accumulate judges into;
 * the wizard's draft is client state until this request (ADR-0052).
 *
 * Org-scoped from the session and never from the body, and guarded like the other authoring
 * routes: an annotator does not author judges.
 */

/**
 * Lowercase kebab-case. **This is public API surface, not an internal label**: a judge's slug
 * is the key in every `/v1` response — `judges["is-missing-repro"]` — and the name a
 * developer writes in their own code. It has to be something a person can type and a JSON
 * key can hold without quoting surprises.
 */
const SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const slugSchema = z
  .string()
  .max(64)
  .regex(SLUG, 'must be lowercase kebab-case, starting with a letter — e.g. `is-missing-repro`')

/**
 * **A ceiling, and it is a cost control rather than a UX one.** Every `llm` judge in a submit
 * costs one real, parallel provider call to validate its pin (ADR-0026). Without a bound, one
 * request could fan out an arbitrary number of paid calls from a single form post.
 */
const MAX_JUDGES = 16

const judgeSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(1).max(80),
  // Refused with a reason rather than silently narrowed to `llm`: a client that sends
  // `code` deserves to learn why, not to get a judge it did not ask for.
  type: z.string().refine((value) => value === 'llm', {
    message:
      'only `llm` judges can be created at M4 — `code` judges have no executor until M5 and ' +
      'would report `failed` on every evaluation',
  }),
  question: z.string().trim().min(1).max(2000),
  polarity: z.enum(['passes', 'fails']),
  // Mirrors `judge_versions_weight_positive`. Validated here so the person sees it beside the
  // field; the database CHECK stays the guarantee (a test asserts both).
  weight: z.number().finite().positive(),
  required: z.boolean().default(false),
  model: z.string().min(1),
  pin: modelPinSchema,
})

const createBodySchema = z
  .object({
    slug: slugSchema,
    name: z.string().trim().min(1).max(80),
    threshold: z.number().finite().min(0).max(1),
    judges: z.array(judgeSchema).min(1, 'a panel needs at least one judge').max(MAX_JUDGES),
  })
  .superRefine((body, ctx) => {
    // Caught here rather than left to `judges_panel_slug_key`, which raises the same SQLSTATE
    // as a taken PANEL slug and would otherwise be reported against the wrong field.
    const seen = new Map<string, number>()
    for (const [index, judge] of body.judges.entries()) {
      const first = seen.get(judge.slug)
      if (first === undefined) {
        seen.set(judge.slug, index)
        continue
      }
      ctx.addIssue({
        code: 'custom',
        path: ['judges', index, 'slug'],
        message: `duplicates judge ${first}'s slug — slugs must be unique within a panel`,
      })
    }
  })

type Issue = { path: string; message: string }

const validationError = (message: string, issues: Issue[]): AppError =>
  new AppError('VALIDATION_ERROR', message, { issues })

export const createPanelRoutes = () =>
  new Hono<AppEnv>()
    .use('/panels', requireRole('admin', 'engineer'))
    .use('/panels/*', requireRole('admin', 'engineer'))
    .post('/panels', async (c) => {
      const { db, clock, modelProvider } = c.var.deps
      const { orgId, userId } = c.var.session

      const body = createBodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!body.success) {
        throw validationError(
          'The request body failed validation.',
          body.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        )
      }

      const result = await createPanel({
        db,
        clock,
        provider: modelProvider,
        orgId,
        actorId: userId,
        requestId: c.var.requestId,
        panel: { slug: body.data.slug, name: body.data.name, threshold: body.data.threshold },
        judges: body.data.judges.map(({ type: _type, ...judge }) => judge),
      })

      if (!result.ok) {
        // **A form error, not an exception** (ADR-0026). 422 with field-level issues, located
        // at the judge that failed, so the wizard renders each reason beside its own model
        // field. Unlike `validate-pin` — which answers a QUESTION and returns 200 — this is a
        // COMMAND that could not be carried out, and the taxonomy's form-error code is this one.
        if (result.kind === 'unsatisfiable_pins') {
          throw validationError(
            'One or more judges have a model pin that cannot be satisfied. Nothing was created.',
            result.failures.map((failure) => ({
              path: `judges.${failure.index}.model`,
              // Verbatim: "the rationale exceeded its length" is actionable, "invalid" is not.
              message: failure.reason,
            })),
          )
        }
        throw validationError('That panel slug is already in use in this organisation.', [
          { path: 'slug', message: 'already in use in this organisation' },
        ])
      }

      return c.json(
        {
          data: {
            panel_id: result.panelId,
            panel_version_id: result.panelVersionId,
            // Live immediately: version 1 is activated in the same transaction that wrote it.
            active: true,
            judges: result.judges.map((judge) => ({
              judge_id: judge.judgeId,
              judge_version_id: judge.judgeVersionId,
              slug: judge.slug,
              // How much failover the pin LEFT — the number ADR-0022 requires on the row, and
              // one no catalogue field could have supplied.
              available_endpoints: judge.availableEndpoints,
              served_by: judge.servedBy,
            })),
          },
          request_id: c.var.requestId,
        },
        201,
      )
    })
    .get('/panels', async (c) => {
      const panels = await listPanels(c.var.deps.db, c.var.session.orgId)
      return c.json({
        data: {
          panels: panels.map((panel) => ({
            id: panel.id,
            slug: panel.slug,
            name: panel.name,
            current_version_id: panel.currentVersionId,
            created_at: panel.createdAt.toISOString(),
          })),
        },
        request_id: c.var.requestId,
      })
    })
