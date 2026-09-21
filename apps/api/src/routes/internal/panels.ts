import { displayNameSchema, modelPinSchema, slugSchema } from '@labelloop/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requirePermission } from '../../middleware/require-permission.ts'
import { findPanelBySlug, listPanels } from '../../repositories/panels.ts'
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
 * Slug and name rules are `@labelloop/contracts`' (`names.ts`), shared with the console's live
 * checklist so the form can never promise what this route refuses. **A judge's slug is public
 * API surface**: it is the key in every `/v1` response — `judges["is-missing-repro"]` — so its
 * alphabet is as small as it can be.
 */

/**
 * **A ceiling, and it is a cost control rather than a UX one.** Every `llm` judge in a submit
 * costs one real, parallel provider call to validate its pin (ADR-0026). Without a bound, one
 * request could fan out an arbitrary number of paid calls from a single form post.
 */
const MAX_JUDGES = 16

const judgeSchema = z.object({
  slug: slugSchema,
  name: displayNameSchema,
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
    name: displayNameSchema,
    threshold: z.number().finite().min(0).max(1),
    /**
     * OPTIONAL, and empty is the normal case (ADR-0060, ADR-0061).
     *
     * It used to require at least one judge, which forced a customer to invent judges before
     * a single trace could exist. Judges are now authored only from an eval pass, so the
     * console sends none and the panel is created COLLECTING. **The array stays** for seeding
     * and tests until M6 replaces it with taxonomy-derived authoring; ADR-0061 is what stops
     * that being quietly re-opened as a console feature.
     */
    judges: z.array(judgeSchema).max(MAX_JUDGES).default([]),
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
    .post('/panels', requirePermission({ panel: ['create'] }), async (c) => {
      const { db, clock, modelProvider, config } = c.var.deps
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
        // A panel is created WITH a key, in the same transaction. The console's onboarding
        // screen hands the person a runnable snippet, and a snippet without a credential in
        // it is not runnable — so the two are one act rather than two (Deviation 40).
        //
        // The name is ours, not the caller's: this is the key the create flow issues, and
        // naming it after the panel is what makes it recognisable in the Keys list later.
        // Keys with chosen names are issued from that screen.
        key: { name: `${body.data.slug} default`, nodeEnv: config.NODE_ENV },
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
          { path: 'slug', message: 'That slug is taken in this organisation — choose another.' },
        ])
      }

      return c.json(
        {
          data: {
            panel_id: result.panelId,
            panel_version_id: result.panelVersionId,
            // Live immediately: version 1 is activated in the same transaction that wrote it.
            active: true,
            // COLLECTING when it has no judges — the state `/v1` reports and the console's
            // Overview onboards against (ADR-0060).
            state: result.judges.length === 0 ? ('collecting' as const) : ('judged' as const),
            // **The only time the plaintext exists anywhere.** Not stored, not logged, not
            // recoverable — the console shows it once, on the panel's own Overview, and says
            // so. Absent only if the caller asked for no key, which the console never does.
            key:
              result.key === undefined
                ? null
                : { id: result.key.id, last4: result.key.last4, plaintext: result.key.plaintext },
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
    /**
     * ONE panel, by SLUG — the panel's Overview and its Judges section, which are two views
     * of the same object and so are one read (Deviations 35, 41).
     *
     * By slug because that is what the console puts in the URL and what a person can share;
     * the id never appears in a link. **A panel in another org answers NOT_FOUND, never
     * FORBIDDEN** — the same posture ADR-0057 takes for orgs, so the response cannot confirm
     * that somebody else's panel exists.
     *
     * Read-only, and there is no authoring counterpart at M4 on purpose: a judge must cite
     * the traces and annotations that produced it, so authoring lands at M6 beside the
     * taxonomy (ADR-0061). The console renders this section locked.
     */
    .get('/panels/:slug', requirePermission({ panel: ['read'] }), async (c) => {
      const panel = await findPanelBySlug(c.var.deps.db, c.var.session.orgId, c.req.param('slug'))
      if (panel === undefined) {
        throw new AppError('NOT_FOUND', 'No such panel.', {
          context: { reason: 'panel is absent or not owned by the session org' },
        })
      }

      return c.json({
        data: {
          id: panel.id,
          slug: panel.slug,
          name: panel.name,
          // Null when the panel has no live version: it exists and cannot be evaluated yet.
          panel_version_id: panel.panelVersionId,
          threshold: panel.threshold,
          // The state `/v1` reports, computed from the same fact — no judges on the live
          // version (ADR-0060).
          state: panel.judges.length === 0 ? ('collecting' as const) : ('judged' as const),
          // Every trace captured, judged or not: it is what the Overview counts toward the
          // annotation gate, and a collecting trace is exactly the kind an expert reads.
          trace_count: panel.traceCount,
          // How many of them somebody has annotated — what the gate card fills toward the
          // target once the floor is met (M5 phase 6). Coverage: one trace counts once,
          // however many people answered it and however often they changed their minds.
          annotated_trace_count: panel.annotatedTraceCount,
          judges: panel.judges.map((judge) => ({
            judge_id: judge.judgeId,
            judge_version_id: judge.judgeVersionId,
            slug: judge.slug,
            name: judge.name,
            question: judge.question,
            polarity: judge.polarity,
            weight: judge.weight,
            required: judge.required,
            model: judge.model,
          })),
          created_at: panel.createdAt.toISOString(),
        },
        request_id: c.var.requestId,
      })
    })
    .get('/panels', requirePermission({ panel: ['read'] }), async (c) => {
      const panels = await listPanels(c.var.deps.db, c.var.session.orgId)
      return c.json({
        data: {
          panels: panels.map((panel) => ({
            id: panel.id,
            slug: panel.slug,
            name: panel.name,
            current_version_id: panel.currentVersionId,
            // The same fact `/v1` reports, from the same place: no judges on the live
            // version means collecting (ADR-0060).
            state: panel.judgeCount === 0 ? ('collecting' as const) : ('judged' as const),
            judge_count: panel.judgeCount,
            trace_count: panel.traceCount,
            created_at: panel.createdAt.toISOString(),
          })),
        },
        request_id: c.var.requestId,
      })
    })
