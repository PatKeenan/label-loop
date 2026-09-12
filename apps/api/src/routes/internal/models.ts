import { Hono } from 'hono'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { requireRole } from '../../middleware/require-role.ts'

/**
 * `GET /internal/models` — what the model picker is populated from (ADR-0053).
 *
 * **Read this route as a list of things it deliberately does NOT say.** Every field below is
 * information the console renders; none of it decides whether a model is offerable, because
 * the catalogue cannot answer that question and measurement says so
 * (`thoughts/shared/research/2026-08-30_model-tier-measurements.md`):
 *
 * - `advertises_structured_output` is passed through and named for what it is. It is a UNION
 *   across a model's endpoints, and `claude-haiku-4.5` advertises it and still broke the
 *   output contract 4 times out of 4. **The console must not filter on it.**
 * - `reasoning_mandatory` is passed through and must NOT be rendered as "this model always
 *   reasons" — that would be false for `gemini-3.5-flash-lite`, which is mandatory and
 *   reported 0 reasoning tokens at `minimal` across three runs.
 * - There is no `data_collection` field anywhere, because no catalogue exposes one (ADR-0023).
 *
 * The gate is `POST /internal/judges/validate-pin`, next door, which makes a real call.
 *
 * Guarded like the keys routes: model choice is part of authoring a judge, which an annotator
 * does not do.
 */
export const createModelRoutes = () =>
  new Hono<AppEnv>()
    .use('/models', requireRole('admin', 'engineer'))
    .use('/models/*', requireRole('admin', 'engineer'))
    .get('/models', async (c) => {
      const result = await c.var.deps.catalogue.list()

      // An explicit failure, not an empty list. A wizard rendering `models.map(...)` cannot
      // tell "this provider has no models" from "we could not ask", and only one of those is
      // worth showing a person (ADR-0054).
      if (!result.ok) {
        throw new AppError('PROVIDER_UNAVAILABLE', result.reason, {
          context: { reason: 'catalogue cold start with no snapshot' },
        })
      }

      return c.json({
        data: {
          models: result.snapshot.models.map((model) => ({
            id: model.id,
            name: model.name,
            // Decimal strings, as published. Parsing to a float would lose precision on a
            // per-token price that is later multiplied by a token count (ADR-0027).
            prompt_usd_per_token: model.promptUsd,
            completion_usd_per_token: model.completionUsd,
            reasoning_mandatory: model.reasoningMandatory,
            supported_efforts: model.supportedEfforts,
            default_effort: model.defaultEffort,
            advertises_structured_output: model.advertisesStructuredOutput,
          })),
          fetched_at: result.snapshot.fetchedAt,
          // The console says "last updated at…" rather than presenting stale prices as
          // current. Degraded and serving is a state worth naming, not hiding.
          stale: result.snapshot.stale,
        },
        request_id: c.var.requestId,
      })
    })
    /**
     * Endpoint detail for ONE model, on demand.
     *
     * Separate from the list because `/models` carries no endpoint count — verified against
     * the live catalogue: 445 models, no such field — so populating it eagerly would mean one
     * HTTP request per model per refresh. It is also the wrong number to lead with: the count
     * that matters is how many endpoints survive THIS judge's pin, which only the validating
     * call knows. What this gives is the denominator — how much failover exists before a pin
     * narrows it, and what constraining quantization would cost.
     *
     * The model id contains a slash (`anthropic/claude-fable-5.1`), so it is matched
     * greedily rather than as one path segment.
     */
    .get('/models/:model_id{.+}/endpoints', async (c) => {
      const result = await c.var.deps.catalogue.endpointsFor(c.req.param('model_id'))
      if (!result.ok) {
        throw new AppError('PROVIDER_UNAVAILABLE', result.reason, {
          context: { reason: 'endpoint detail unavailable and nothing cached' },
        })
      }

      return c.json({
        data: {
          model_id: result.endpoints.modelId,
          total_endpoints: result.endpoints.total,
          // `unknown` is its own bucket and is never merged: pinning a precision drops every
          // endpoint that merely did not declare one, which is most of the loss in practice
          // (13 endpoints down to 6 on the one open-weights model measured).
          by_quantization: result.endpoints.byQuantization,
          fetched_at: result.endpoints.fetchedAt,
          stale: result.endpoints.stale,
        },
        request_id: c.var.requestId,
      })
    })
