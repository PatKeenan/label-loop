import { z } from '@hono/zod-openapi'

/**
 * ANNOTATION — what an expert records about one trace (ADR-0066), and the gate that decides
 * when a panel is worth annotating at all (ADR-0061).
 *
 * These live in contracts rather than in either app because BOTH sides read them: the API
 * enforces the gate and the note rules, and the console draws the progress toward the same
 * floor and disables the same Save button. A floor that differed between them would be a
 * screen promising something the server refuses.
 */

/**
 * The count of traces that unlocks annotation for a panel, and the count at which a first
 * pass is worth doing (ADR-0061; 6c decision 3).
 *
 * **Both numbers exist on purpose.** A floor shown on its own reads as the goal, and an expert
 * who annotates 50 traces is still largely seeing one-offs where 100 starts showing patterns.
 * Neither is measured yet — they guide rather than bound, which is why PRODUCT.md 5.6 drives
 * taxonomy size by saturation rather than by a cap.
 */
export const ANNOTATION_FLOOR = 50
export const ANNOTATION_TARGET = 100

/**
 * What an annotator can answer (ADR-0066). Three values, and `skipped` is one of them: a skip
 * is an ANSWER we store, not the absence of one — it frees the trace for someone else, and
 * "nobody could judge this" is itself a finding M6 reads.
 */
export const ANNOTATION_OUTCOMES = ['acceptable', 'not_acceptable', 'skipped'] as const
export type AnnotationOutcome = (typeof ANNOTATION_OUTCOMES)[number]

/** Short notes cluster; essays do not. Enforced here, and again by a CHECK on the column. */
export const ANNOTATION_NOTE_MAX_LENGTH = 280

/**
 * The write. `note` is REQUIRED on `not_acceptable` and REFUSED on `skipped`, which is a rule
 * about the answer rather than about the field — so it is expressed as a refinement on the
 * whole body, with the issue reported on `note` where the console shows it.
 *
 * `acceptable` may carry a note or not: agreement needs no reason, and any required field on
 * the fast path slows the common case (plan decision 5).
 */
export const annotationRequestSchema = z
  .object({
    item_id: z.string().min(1),
    outcome: z.enum(ANNOTATION_OUTCOMES),
    note: z.string().max(ANNOTATION_NOTE_MAX_LENGTH).optional(),
  })
  .superRefine((body, ctx) => {
    const note = body.note?.trim() ?? ''
    if (body.outcome === 'not_acceptable' && note === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'Say what is wrong with it — the note is what the taxonomy is built from.',
      })
    }
    if (body.outcome === 'skipped' && note !== '') {
      ctx.addIssue({
        code: 'custom',
        path: ['note'],
        message: 'A skip carries no note. Answer "not acceptable" to say what is wrong.',
      })
    }
  })

export type AnnotationRequest = z.infer<typeof annotationRequestSchema>
