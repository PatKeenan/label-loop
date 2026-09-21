import { ANNOTATION_FLOOR, ANNOTATION_TARGET } from '@labelloop/contracts'
import { Link } from '@tanstack/react-router'
import { Button } from '../ui/button.tsx'
import { Mark } from './mark.tsx'

/**
 * The annotation gate, shown as a COUNT (ADR-0061; 6c decision 3).
 *
 * **Both numbers are on screen, and that is the decision.** 50 unlocks annotation and 100 is
 * where a first pass is worth doing — a floor shown on its own gets read as the goal, and an
 * expert annotating 50 traces is still largely seeing one-offs where 100 starts showing
 * patterns. Neither number is measured yet; they guide rather than bound, which is why
 * PRODUCT.md 5.6 drives taxonomy size by saturation rather than a cap.
 *
 * **Progress is visible from the first call**, because a gate with no visible distance is
 * indistinguishable from a dead end.
 *
 * The two numbers moved to `@labelloop/contracts` when the API began enforcing the floor
 * (M5 phase 4): the server refuses a queue below it, and this bar fills toward the number the
 * server is checking.
 *
 * **The card measures ONE thing at a time, and which thing changes when the gate opens**
 * (M5 phase 6). Below the floor the work is collecting traces, so it counts traces toward 50.
 * Above it, collecting is no longer the job — reading them is — so it counts ANNOTATED traces
 * toward the target, and the trace count moves to the line underneath. Two bars would ask the
 * reader to work out which one is theirs; the card's job is to name the next thing to do.
 */
export const Gate = ({
  traceCount,
  annotatedTraceCount,
  panelSlug,
  orgSlug,
}: {
  traceCount: number
  /** Traces somebody has answered — coverage, so one trace counts once however many did. */
  annotatedTraceCount: number
  panelSlug: string
  orgSlug: string
}) => {
  const open = traceCount >= ANNOTATION_FLOOR
  // Whichever measure the card is on: traces toward the floor, then annotations toward the
  // target. The bar always fills toward the number the headline is counting against.
  const [value, goal] = open
    ? ([annotatedTraceCount, ANNOTATION_TARGET] as const)
    : ([traceCount, ANNOTATION_FLOOR] as const)
  const pct = Math.min(100, Math.round((value / goal) * 100))

  // Deliberately short. It was a headline, two paragraphs and a mark repeating the one in the
  // page head; the count and the bar are the content, and one line says what they lead to.
  // The integrator's note about `state: "collecting"` moved beside the snippet it concerns.
  return (
    <section className="flex flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
      <div className="flex flex-col gap-[var(--gap-inline)]">
        <div className="flex flex-wrap items-baseline gap-[var(--gap-tight)]">
          <strong className="font-mono text-display tabular-nums">{value}</strong>
          <span className="text-muted-foreground">
            {open
              ? `of ${ANNOTATION_TARGET} traces annotated`
              : `of ${ANNOTATION_FLOOR} traces before annotation opens`}
          </span>
          {open ? (
            <Mark tone="success" className="ml-auto">
              ready to annotate
            </Mark>
          ) : null}
        </div>
        <div
          className="h-[var(--space-2)] overflow-hidden rounded-[var(--radius-pill)] bg-muted"
          role="progressbar"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={goal}
          aria-label={
            open
              ? 'Traces annotated toward the target'
              : 'Traces collected toward the annotation gate'
          }
        >
          <span className="block h-full bg-muted-foreground" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <p className="m-0 text-body text-muted-foreground">
        {open ? (
          <>
            {/* The trace count keeps its place on the card, demoted to a clause: it is still
                the denominator of everything above, and dropping it would leave "12 of 100
                annotated" with nothing saying how much there is to annotate. */}
            <strong className="text-foreground">{traceCount}</strong> traces collected. An expert
            reviews these and says what went wrong in their own words; judges are written from those
            notes.
          </>
        ) : (
          <>
            Annotation opens at {ANNOTATION_FLOOR}.{' '}
            <strong className="text-foreground">{ANNOTATION_TARGET}</strong> is where a first pass
            is worth doing — every trace is kept either way.
          </>
        )}
      </p>

      {/*
        The way IN, from the screen that says the gate is open — live at M5 (plan phase 5). It
        leaves the console for the annotator surface, which is the point: reviewing is the same
        act whoever does it, and the frame it happens in is a preference (ADR-0064).
      */}
      {open ? (
        <div>
          <Button asChild variant="outline">
            <Link to="/review/$panelSlug" params={{ panelSlug }} search={{ org: orgSlug }}>
              Review traces
            </Link>
          </Button>
        </div>
      ) : null}
    </section>
  )
}
