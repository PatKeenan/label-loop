import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  errorEnvelopeSchema,
  evaluateRequestSchema,
  evaluateResponseSchema,
  idempotencyKeyHeaderSchema,
  panelIdParamSchema,
} from '@labelloop/contracts'
import type { AppEnv } from '../../../app-env.ts'
import { API_KEY_SECURITY_SCHEME } from '../../../docs.ts'
import { apiKeyAuth } from '../../../middleware/api-key-auth.ts'
import { byApiKey, rateLimit } from '../../../middleware/rate-limit.ts'
import { evaluate } from '../../../services/evaluate.ts'
import { validationHook } from './index.ts'

/**
 * `POST /v1/panels/{panel_id}/evaluate` — the product's one endpoint at M0 (ADR-0019).
 *
 * The handler is deliberately about nothing but the HTTP layer: validate, authorise,
 * delegate, envelope. Every rule with judgement in it lives in `services/evaluate.ts`,
 * and every rule about talking to a model lives in `llm/`.
 */

const errorResponse = (description: string) => ({
  description,
  content: { 'application/json': { schema: errorEnvelopeSchema } },
})

const evaluateRoute = createRoute({
  method: 'post' as const,
  path: '/panels/{panel_id}/evaluate',
  tags: ['Evaluation'],
  summary: 'Run a panel of judges over one artifact',
  description:
    'Sends an artifact to every judge on the panel’s live version and returns one verdict ' +
    'per judge, each with the reasoning that produced it, plus the panel’s decision. We ' +
    'never generate the artifact — your agent does — but we are the inference path for ' +
    'the judge calls, which is what makes the stored trace ours to give you.',
  security: [{ [API_KEY_SECURITY_SCHEME]: [] }],
  // Authentication runs as route middleware so an unauthenticated caller is turned away
  // before any work is done on their behalf.
  //
  // **The order is load-bearing and has its own test.** Rate limiting runs SECOND, on the
  // key `apiKeyAuth` just established: limiting first would let an anonymous flood — no
  // key, guessing at a panel id — burn a real customer's allowance, which is the denial of
  // service the limiter exists to prevent (ADR-0040).
  middleware: [apiKeyAuth(), rateLimit({ subject: byApiKey })] as const,
  request: {
    params: panelIdParamSchema,
    headers: idempotencyKeyHeaderSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: evaluateRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'The panel’s decision, and every judge’s verdict behind it.',
      content: { 'application/json': { schema: evaluateResponseSchema } },
    },
    401: errorResponse(
      'The key is missing, malformed, revoked, or scoped to a different panel. All four ' +
        'answer identically on purpose: a 403 would confirm that another panel exists.',
    ),
    404: errorResponse('No such panel, or the panel has no live version to run.'),
    422: errorResponse('The request body failed contract validation. `issues[]` says where.'),
    429: errorResponse(
      'This key has spent its allowance. `Retry-After` says how many seconds until the ' +
        'next request will be accepted — it is computed from the bucket, not a constant.',
    ),
    503: errorResponse('No judge could be reached, or the circuit for their model is open.'),
    504: errorResponse('No judge answered within the gateway’s timeout.'),
  },
})

export const createEvaluateRoutes = () => {
  const routes = new OpenAPIHono<AppEnv>({ defaultHook: validationHook as never })

  return routes.openapi(evaluateRoute, async (c) => {
    const { panel_id } = c.req.valid('param')
    const idempotencyKey = c.req.valid('header')['idempotency-key']
    const { deps } = c.var

    const evaluation = await evaluate(
      {
        db: deps.db,
        clock: deps.clock,
        gateway: deps.modelGateway,
        errorReporter: deps.errorReporter,
        jobs: deps.jobs,
      },
      {
        panelId: panel_id,
        apiKey: c.var.apiKey,
        request: c.req.valid('json'),
        requestId: c.var.requestId,
        // Accepted, echoed into the logs, and not yet enforced — because there is nothing
        // for it to conflict with. Evaluation is naturally idempotent per request
        // (CONVENTIONS.md "API rules"): the same body evaluates the same way, and each
        // call is its own permanent `tr_` row rather than a mutation to reconcile. The
        // header is in the contract from day one so replay protection can be added at the
        // point it means something — M2's metering, where a retry must not double-bill.
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
      c.var.logger,
    )

    return c.json({ data: evaluation, request_id: c.var.requestId }, 200)
  })
}
