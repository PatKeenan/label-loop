import { modelPinSchema } from '@labelloop/contracts'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppEnv } from '../../app-env.ts'
import { AppError } from '../../errors.ts'
import { validatePin } from '../../llm/validate-pin.ts'
import { requirePermission } from '../../middleware/require-permission.ts'

/**
 * `POST /internal/judges/validate-pin` — **the gate** (ADR-0026, ADR-0053).
 *
 * `GET /internal/models` next door populates the picker; this decides whether a judge can
 * actually be created against a choice, and it decides it by making a real call. Nothing
 * static can answer the question. `supported_parameters` is a union across a model's
 * endpoints, so it describes the best any of them can do rather than what the one that
 * answers will: `claude-sonnet-5` advertised structured output with three of its nine unable
 * to honour it. Nor can any catalogue field say how many endpoints survive a given pin —
 * `claude-sonnet-5` had 5 of 9 and `gpt-5.6-sol` had 1 of 5 — which is the number ADR-0022
 * requires on the row.
 *
 * **An unsatisfiable pin is a 200, not an error.** The wizard renders `reason` beside the
 * field; it does not catch an exception to discover that a form is invalid. `validatePin`
 * already returns rather than throws for exactly this reason, and the route preserves it:
 * the ONLY failure envelope here is one where we could not ask at all.
 *
 * `reason` is surfaced VERBATIM because the measurements say the difference matters —
 * "the rationale exceeded 280 characters" is actionable and "invalid output" is not.
 */

const bodySchema = z.object({
  /** Route-qualified, e.g. `openrouter:anthropic/claude-fable-5.1` or `fake:deterministic`. */
  model: z.string().min(1),
  pin: modelPinSchema,
})

export const createJudgeRoutes = () =>
  new Hono<AppEnv>().post(
    '/judges/validate-pin',
    requirePermission({ judge: ['read'] }),
    async (c) => {
      const body = bodySchema.safeParse(await c.req.json().catch(() => undefined))
      if (!body.success) {
        throw new AppError('VALIDATION_ERROR', 'The request body failed validation.', {
          issues: body.error.issues.map((issue) => ({
            path: issue.path.map(String).join('.'),
            message: issue.message,
          })),
        })
      }

      const result = await validatePin({
        // The registry rather than the gateway, deliberately: an unsatisfiable pin is an
        // ANSWER, and a form check that tripped the circuit breaker for real judge traffic
        // would be worse than useless. See `app-env.ts` on `modelProvider`.
        provider: c.var.deps.modelProvider,
        model: body.data.model,
        pin: body.data.pin,
        now: () => new Date(c.var.deps.clock.now()),
      })

      return c.json({
        data: result.ok
          ? {
              ok: true,
              validated_at: result.validation.validated_at,
              // The number ADR-0022 requires on the row: how much failover this pin LEAVES.
              // Measured, not read from a catalogue — `claude-sonnet-5` had 5 of 9 and
              // `gpt-5.6-sol` had 1 of 5.
              available_endpoints: result.validation.available_endpoints,
              served_by: result.validation.served_by,
            }
          : {
              ok: false,
              // Verbatim. "The rationale exceeded its length" is actionable; "invalid" is not.
              reason: result.reason,
              kind: result.kind ?? null,
            },
        request_id: c.var.requestId,
      })
    },
  )
