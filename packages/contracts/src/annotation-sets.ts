import { z } from '@hono/zod-openapi'
import { displayNameSchema } from './names.ts'

/**
 * THE ANNOTATION SET — a named, snapshotted selection of one panel's traces, assigned to
 * annotators (ADR-0079, ADR-0080, ADR-0082, ADR-0085).
 *
 * Here rather than in either app because both sides read it: the API validates the writes with
 * these schemas, and the console's create dialog draws the same size bound and the same name
 * rules as a live checklist. A form that promised a size the server refuses is the drift
 * `names.ts` exists to prevent, applied to a second object.
 */

/**
 * HOW A SET'S TRACES ARE PICKED, resolved ONCE at creation or top-up (ADR-0080).
 *
 * `manual` is an engineer selecting rows in the trace table they are already reading; the
 * three `_n` pickers take a count. There is no `low_confidence` and no `judge_disagreement`
 * here: those are M6's, they need a judge to have run, and a strategy that cannot be resolved
 * is a value nothing may store.
 *
 * The value is recorded on every membership row and copied onto the annotation the queue
 * produces, so "which picker found the failures" stays answerable (ADR-0080).
 */
export const ANNOTATION_SET_STRATEGIES = ['manual', 'latest_n', 'earliest_n', 'random_n'] as const
export type AnnotationSetStrategy = (typeof ANNOTATION_SET_STRATEGIES)[number]

/** The three that take a count rather than a list of ids. */
export const SIZED_ANNOTATION_SET_STRATEGIES = ['latest_n', 'earliest_n', 'random_n'] as const
export type SizedAnnotationSetStrategy = (typeof SIZED_ANNOTATION_SET_STRATEGIES)[number]

/**
 * A set holds at most this many traces, however many top-ups it takes to get there (ADR-0082).
 *
 * Saturation bounds a pass, not stamina: past roughly this many, new traces stop producing new
 * categories, so a larger set pays for attention that finds nothing. It is also a number a
 * person can finish, which is what makes "done" mean something.
 */
export const ANNOTATION_SET_MAX_SIZE = 250

/** The name a person types. Same rules as a panel's or a key's — one definition, in `names.ts`. */
export const annotationSetNameSchema = displayNameSchema

const sizeSchema = z
  .number()
  .int()
  .min(1)
  .max(ANNOTATION_SET_MAX_SIZE)
  .describe('How many traces to pick')

const traceIdsSchema = z
  .array(z.string().min(1))
  .min(1)
  .max(ANNOTATION_SET_MAX_SIZE)
  .describe('The traces to add, exactly as selected')

/**
 * WHAT TO PICK, without the name — shared by create and top-up, because a top-up is the same
 * picker run again against what the set does not already hold.
 *
 * A discriminated union rather than an object with two optional fields: `{ strategy: 'manual',
 * size: 25 }` and `{ strategy: 'random_n', trace_ids: [...] }` are both nonsense, and a union
 * makes them unrepresentable instead of making them a refinement somebody can forget.
 */
export const annotationSetPickSchema = z.discriminatedUnion('strategy', [
  z.object({ strategy: z.literal('manual'), trace_ids: traceIdsSchema }),
  z.object({ strategy: z.literal('latest_n'), size: sizeSchema }),
  z.object({ strategy: z.literal('earliest_n'), size: sizeSchema }),
  z.object({ strategy: z.literal('random_n'), size: sizeSchema }),
])

export type AnnotationSetPick = z.infer<typeof annotationSetPickSchema>

/** How many traces a pick asks for, whichever arm it is — the number the cap is checked against. */
export const pickSize = (pick: AnnotationSetPick): number =>
  pick.strategy === 'manual' ? pick.trace_ids.length : pick.size

export const createAnnotationSetRequestSchema = z.intersection(
  z.object({ name: annotationSetNameSchema }),
  annotationSetPickSchema,
)

export type CreateAnnotationSetRequest = z.infer<typeof createAnnotationSetRequestSchema>

export const topUpAnnotationSetRequestSchema = annotationSetPickSchema

export type TopUpAnnotationSetRequest = z.infer<typeof topUpAnnotationSetRequestSchema>

/**
 * WHO IS ASSIGNED, declared in full — this is a PUT, so the list is the assignment, and anyone
 * currently assigned who is not named is UNASSIGNED by it. Unassigning stamps `unassigned_at`
 * and never deletes: their answers were work that happened, they stay visible, and they stay in
 * the record M6 measures agreement from (ADR-0086, open question 3).
 *
 * **At most one dictator, and two or more annotators must have one** (ADR-0081, open question
 * 6). The second half is checked in the service, against what the call would LEAVE — one rule
 * in both directions, so no ordering of calls reaches a set with a disagreement and nobody to
 * settle it. This schema owns the half it can see: a body naming two dictators is never valid,
 * whatever the set currently holds.
 */
export const assignAnnotatorsRequestSchema = z
  .object({
    annotators: z
      .array(
        z.object({
          user_id: z.string().min(1),
          is_dictator: z.boolean().default(false),
        }),
      )
      .max(ANNOTATION_SET_MAX_SIZE),
  })
  .superRefine((body, ctx) => {
    const ids = body.annotators.map((annotator) => annotator.user_id)
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['annotators'],
        message: 'A person appears twice. Each annotator is assigned once.',
      })
    }
    if (body.annotators.filter((annotator) => annotator.is_dictator).length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['annotators'],
        message: 'One dictator per set. Where answers differ, exactly one of them counts.',
      })
    }
  })

export type AssignAnnotatorsRequest = z.infer<typeof assignAnnotatorsRequestSchema>

/**
 * The refusal ADR-0081 exists to enforce, phrased once so the API and the console say the same
 * sentence. Changing who holds the role RE-READS every past disagreement in the set — the
 * dictator rule is a read rule — which is why the call must always leave one.
 */
export const DICTATOR_REQUIRED =
  'Two or more annotators need a dictator — the one whose answer counts where they differ.'
