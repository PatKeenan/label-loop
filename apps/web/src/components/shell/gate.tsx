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
 */
export const ANNOTATION_FLOOR = 50
export const ANNOTATION_TARGET = 100

export const Gate = ({ traceCount }: { traceCount: number }) => {
  const open = traceCount >= ANNOTATION_FLOOR
  // Against the FLOOR, not the target: the bar this fills is the one that unlocks something.
  const pct = Math.min(100, Math.round((traceCount / ANNOTATION_FLOOR) * 100))

  return (
    <section className="flex flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
      <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
        <Mark tone="success">{open ? 'ready to annotate' : 'collecting'}</Mark>
        <h2 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">
          {open
            ? `${traceCount} traces collected — annotation is open`
            : 'Send traffic — that is all there is to do yet'}
        </h2>
      </div>

      <div className="flex flex-col gap-[var(--gap-tight)]">
        <div className="flex flex-wrap items-baseline gap-[var(--gap-tight)]">
          <strong className="font-mono text-title tabular-nums">{traceCount}</strong>
          <span className="text-muted-foreground">
            {open
              ? `traces · ${ANNOTATION_TARGET} is where a first pass is worth doing`
              : `of ${ANNOTATION_FLOOR} traces before annotation opens`}
          </span>
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

      {open ? (
        <>
          <p className="m-0 text-body">
            An expert reads these traces one at a time and says what went wrong in their own words.
            Nothing is sorted into categories yet — the categories come out of what they write.
          </p>
          <p className="m-0 text-body text-muted-foreground">
            The panel keeps collecting while they work. <strong>Judges stay locked</strong> until
            those notes are clustered into a taxonomy, because a judge is created from a category,
            and the category is what ties it back to the traces that produced it.
          </p>
          <Data>annotation lands at M5</Data>
        </>
      ) : (
        <>
          <p className="m-0 text-body text-muted-foreground">
            {ANNOTATION_FLOOR} is the floor, not the goal —{' '}
            <strong>{ANNOTATION_TARGET} is where a first pass is worth doing</strong>, because that
            is where an expert stops seeing one-offs and starts seeing patterns. Nothing is thrown
            away below it: every trace you send is kept and annotated later.
          </p>
          <p className="m-0 text-body text-muted-foreground">
            Every call is stored and nothing is judged, so responses carry{' '}
            <Data className="text-foreground">state: "collecting"</Data> and no verdict. A step that
            blocks on a failure is never told everything is fine; treat it as a pass while you
            integrate.
          </p>
        </>
      )}
    </section>
  )
}
