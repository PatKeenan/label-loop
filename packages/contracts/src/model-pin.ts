import { z } from '@hono/zod-openapi'

/**
 * **What a frozen judge version pins** (ADR-0022). Not a model name, and not an endpoint:
 * the *properties an endpoint must have* in order to serve this judge.
 *
 * The defect this exists against is measurable rather than theoretical. Measured against
 * the live catalogue on 2026-08-28, `anthropic/claude-sonnet-5` exposed nine endpoints and
 * three of them — all Vertex regions — did not support structured output at all, while the
 * model-level capability list advertised it anyway because that field is a UNION across
 * endpoints. A judge frozen to a bare model name therefore has its actual capability
 * decided by routing, at call time, by someone who is not us. Judge output is a parsed
 * structured contract, so the failure is not a degraded answer but an unusable one.
 *
 * It lives in `contracts` rather than in `apps/api` for two reasons: it is written to a
 * column ADR-0003 freezes forever, and it becomes an API surface at M4's judge picker.
 * Type truth is this package's whole job.
 */

/**
 * The access paths a judge can be reached through — the prefix half of `<route>:<id>`.
 *
 * The grammar exists because the same model is not the same capability surface across
 * access paths (ADR-0021), so `anthropic/claude-sonnet-5` reached through an aggregator
 * and reached through a first-party adapter are not provably the same judge. `finetune:`
 * is additive at M7, which is the property the grammar was chosen for.
 */
export const MODEL_ROUTES = ['fake', 'openrouter'] as const

export type ModelRoute = (typeof MODEL_ROUTES)[number]

/**
 * The one capability every `llm` judge requires at M1, and the reason the pin exists.
 * A free string rather than an enum: these are the provider's own parameter names, and a
 * closed list here would have to be reopened by a migration every time a provider named
 * a new one — which is precisely what a frozen column must not need.
 */
export const CAPABILITY_STRUCTURED_OUTPUTS = 'structured_outputs'

/**
 * How hard the model is permitted to deliberate before it answers.
 *
 * **`none` is the default and the reason the field is not optional.** These models are
 * autoregressive, which is why `judgeOutputSchema` emits rationale before verdict
 * (ADR-0019): a verdict generated first makes its own reasoning post-hoc. Provider-side
 * reasoning defeats that ordering completely — the model deliberates privately, we are
 * billed for it, and *then* it emits rationale → verdict, so the verdict was already
 * settled during the part we cannot see, store, show an annotator, or correct.
 *
 * Whether deliberation makes a judge BETTER is deliberately not asserted here. It is
 * empirical, and M6 can answer it as an A/B between two immutable versions.
 *
 * **Ordered ascending, and the full set the catalogue actually uses.** It originally held
 * four values, which turned out not to cover the vocabulary: measured on 2026-08-30, the
 * live catalogue supports `minimal` on 29 models, `xhigh` on 53 and `max` on 47, and
 * **20 models DEFAULT to one of the three** — including `google/gemini-3.5-flash-lite`,
 * whose default is `minimal` and whose reasoning is mandatory, so it could be neither
 * pinned to its default nor disabled. Since ADR-0025 requires the default to be written in
 * as a concrete literal, a missing value is not a cosmetic gap: it makes those models
 * unpinnable. Widened before P4 froze the column (ADR-0025, amended).
 *
 * `none` and `minimal` are distinct and both are kept: `none` disables deliberation, while
 * `minimal` is the smallest amount of it a model that cannot be silenced will do.
 */
export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export const reasoningEffortSchema = z.enum(REASONING_EFFORTS).openapi({
  description:
    'How much the model may deliberate before answering. `none` where the model permits ' +
    'it, because hidden deliberation defeats the reasoning-before-verdict ordering the ' +
    'judge output schema exists to force.',
  example: 'none',
})

export const modelPinSchema = z
  .object({
    capabilities: z.array(z.string().min(1)).openapi({
      description:
        'Provider parameters an endpoint must actually support to serve this judge. At ' +
        'M1 this is always `structured_outputs`, because a judge that cannot be held to ' +
        'a schema is not a judge.',
      example: [CAPABILITY_STRUCTURED_OUTPUTS],
    }),
    /**
     * ADR-0023: one writable value, written as a value on every row rather than inherited
     * from an ambient default. The redundancy is the point — it is what makes a future
     * exception auditable rather than guessed at, and adding a second writable value later
     * stays additive because every row already records what it was created under.
     */
    data_collection: z.literal('deny').openapi({
      description:
        'Excludes endpoints that log or train on prompts. Fixed at `deny` (ADR-0023), and ' +
        'recorded per version so that a future exception is visible on the row rather ' +
        'than inferred from a deployment date.',
      example: 'deny',
    }),
    /**
     * Optional, and omitted means unconstrained (ADR-0025). Proprietary hosted routes have
     * no quantization variance, so naming one there would be a constraint with nothing to
     * bind; it binds where it is written, which is the open-weights case ADR-0022 was
     * actually about — `z-ai/glm-5.3` is served at fp4, fp8 and bf16 across sixteen hosts
     * at overlapping prices, and M6 measures agreement per immutable version.
     */
    quantizations: z
      .array(z.string().min(1))
      .optional()
      .openapi({
        description:
          'Acceptable weight precisions. Omitted means unconstrained, which is the right ' +
          'answer for hosted proprietary models — they have no quantization variance to ' +
          'constrain.',
        example: ['bf16'],
      }),
    reasoning: z
      .object({ effort: reasoningEffortSchema.default('none') })
      .default({ effort: 'none' })
      .openapi({
        description:
          'Always present, always a concrete literal. A pin that says nothing about ' +
          'effort is a pin whose meaning changes when the provider changes its default, ' +
          'which is the exact drift a frozen judge version exists to prevent.',
      }),
  })
  .openapi('ModelPin')

/**
 * The pin as it is STORED — every default resolved to a literal. The schema's input type
 * permits omissions; nothing written to a `jdv_` row ever does.
 */
export type ModelPin = z.infer<typeof modelPinSchema>

/**
 * The pin every `fake:` judge carries.
 *
 * A `fake:` route has no endpoints to constrain, so this row constrains nothing — and it
 * is written anyway (ADR-0025), so the database CHECK can be ADR-0022's clean mirror of
 * the existing model/type rule (`code` → NULL, `llm` → NOT NULL) rather than a
 * route-conditional special case that would have to be reasoned about at every read.
 */
export const DEFAULT_FAKE_PIN: ModelPin = {
  capabilities: [CAPABILITY_STRUCTURED_OUTPUTS],
  data_collection: 'deny',
  reasoning: { effort: 'none' },
}

/**
 * What one real call OBSERVED when a pin was validated, immediately before the `jdv_`
 * froze (ADR-0026).
 *
 * **Stored in its own column, never inside the pin.** The pin is a constraint translated
 * onto the wire; this is a measurement taken once. Merging them would put non-request data
 * into the request body — and worse, would make a frozen constraint look like it contained
 * a fact about the world on a particular afternoon.
 *
 * `available_endpoints` is the one nothing static can predict, and the reason ADR-0022
 * requires recording it: measured 2026-08-29, `anthropic/claude-sonnet-5` had 5 endpoints
 * of 9 under the full pin and `openai/gpt-5.6-sol` had **1 of 5** — a judge with no
 * failover is fragile in a way one with four spares is not, and that is knowable only here.
 */
export const modelPinValidationSchema = z
  .object({
    validated_at: z.iso.datetime().openapi({
      description: 'When the validating call was made. UTC ISO-8601, like every timestamp.',
      example: '2026-08-30T12:00:00.000Z',
    }),
    available_endpoints: z
      .number()
      .int()
      .min(0)
      .openapi({
        description:
          'How many endpoints survived the pin. Zero would mean the judge cannot be ' +
          'served at all, which is why validation happens before the version freezes.',
        example: 5,
      }),
    served_by: z.string().openapi({
      description:
        'The dated id of the endpoint that answered the validating call — not the ' +
        'alias, because the dated snapshot is the identity that actually served it.',
      example: 'anthropic/claude-sonnet-5-20260630',
    }),
  })
  .openapi('ModelPinValidation')

export type ModelPinValidation = z.infer<typeof modelPinValidationSchema>

/** A model reference split into the half that dispatches and the half that is sent. */
export type ModelRef = {
  /** Which adapter answers for this model. The registry dispatches on exactly this. */
  route: ModelRoute
  /** The id as the route itself spells it — `anthropic/claude-sonnet-5`, `deterministic`. */
  nativeId: string
}

const isModelRoute = (value: string): value is ModelRoute =>
  (MODEL_ROUTES as readonly string[]).includes(value)

/**
 * Split `<route>:<native-id>`, or answer `undefined`.
 *
 * **This is the half callers at an edge should reach for**, and it answers `undefined`
 * rather than a reason on purpose: the caller knows what it was reading and can say so,
 * which this cannot. The seed naming `SEED_MODEL_A` in its own message is the shape
 * (`scripts/seed.ts`, `seedId`), and it is what CONVENTIONS' "crash at startup with a
 * named field" actually requires — a message this function wrote could only name the
 * value, never the variable it came from.
 *
 * It is also what the adapter registry needs, because an unknown route is not a
 * programming error at the point the registry meets one: it is a `jdv_` row naming a route
 * this build does not have, which becomes an ordinary `unavailable` failure so that the
 * composite still satisfies the port's shared contract suite.
 */
export const modelRefOf = (model: string): ModelRef | undefined => {
  const separator = model.indexOf(':')
  if (separator < 1) return undefined
  const route = model.slice(0, separator)
  const nativeId = model.slice(separator + 1)
  if (!isModelRoute(route) || nativeId.length === 0) return undefined
  return { route, nativeId }
}

/**
 * The throwing half, for callers holding a value that has no business being malformed —
 * a `jdv_.model` already written, the way `parseId` is used on ids read back out of the
 * database. At an edge, use `modelRefOf` and write a message that names the field.
 */
export const parseModelRef = (model: string): ModelRef => {
  const ref = modelRefOf(model)
  if (ref === undefined) {
    throw new TypeError(
      `not a route-qualified model id: ${model} (expected one of ${MODEL_ROUTES.join(', ')} ` +
        'followed by ":" and a non-empty id)',
    )
  }
  return ref
}
