import { ANNOTATION_FLOOR, ANNOTATION_TARGET } from '@labelloop/contracts'
import { Data, Mark } from './mark.tsx'

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
 */
export const Gate = ({ traceCount }: { traceCount: number }) => {
  const open = traceCount >= ANNOTATION_FLOOR
  // Against the FLOOR, not the target: the bar this fills is the one that unlocks something.
  const pct = Math.min(100, Math.round((traceCount / ANNOTATION_FLOOR) * 100))

  // Deliberately short. It was a headline, two paragraphs and a mark repeating the one in the
  // page head; the count and the bar are the content, and one line says what they lead to.
  // The integrator's note about `state: "collecting"` moved beside the snippet it concerns.
  return (
    <section className="flex flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
      <div className="flex flex-col gap-[var(--gap-inline)]">
        <div className="flex flex-wrap items-baseline gap-[var(--gap-tight)]">
          <strong className="font-mono text-display tabular-nums">{traceCount}</strong>
          <span className="text-muted-foreground">
            {open ? 'traces collected' : `of ${ANNOTATION_FLOOR} traces before annotation opens`}
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
          aria-valuenow={traceCount}
          aria-valuemin={0}
          aria-valuemax={ANNOTATION_FLOOR}
          aria-label="Traces collected toward the annotation gate"
        >
          <span className="block h-full bg-muted-foreground" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <p className="m-0 text-body text-muted-foreground">
        {open ? (
          <>
            An expert can now review these and say what went wrong in their own words; judges are
            written from those notes. <Data>Annotation lands at M5.</Data>
          </>
        ) : (
          <>
            Annotation opens at {ANNOTATION_FLOOR}.{' '}
            <strong className="text-foreground">{ANNOTATION_TARGET}</strong> is where a first pass
            is worth doing — every trace is kept either way.
          </>
        )}
      </p>
    </section>
  )
}
