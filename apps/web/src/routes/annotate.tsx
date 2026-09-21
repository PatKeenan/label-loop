import { ANNOTATION_FLOOR } from '@labelloop/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { assignedSetsQuery } from '../api/queries.ts'
import { AnnotateFrame, Stage } from '../components/annotate/annotate-frame.tsx'
import type { ConsoleSearch } from '../components/shell/context.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { Button } from '../components/ui/button.tsx'

/**
 * `/annotate` — WHERE AN ANNOTATOR LANDS (r6 decision 12, ADR-0079).
 *
 * **It lists the SETS ASSIGNED TO THIS PERSON, and nothing else.** r6 drew every panel in the
 * org; phase 7 replaced the panel-wide queue with assigned work, so a person with nothing
 * assigned sees an empty landing and the surface says so. That is the honest answer: there is
 * no work to find, and inventing some would be the opposite of "somebody decided this was
 * worth your afternoon".
 *
 * A set whose panel is still below the floor is LISTED with its distance to the gate rather
 * than hidden — a gate with no visible distance is indistinguishable from a dead end. Counting
 * traces is not an operator signal (ADR-0067 withholds verdicts, confidence, cost and ids), so
 * a count and a bar are what this screen is allowed to say. The set's NAME is shown; its
 * strategy is not.
 */
export const AnnotateHomePage = () => {
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const orgId = context.state === 'ready' ? context.orgId : ''
  const sets = useQuery({ ...assignedSetsQuery(orgId), enabled: context.state === 'ready' })

  if (context.state === 'pending' || sets.isPending) {
    return (
      <AnnotateFrame>
        <Stage title="Loading…" />
      </AnnotateFrame>
    )
  }

  if (sets.error !== null) {
    return (
      <AnnotateFrame>
        <Stage title="This couldn’t be loaded">
          <p className="m-0 text-muted-foreground">Nothing has been changed. Try again shortly.</p>
        </Stage>
      </AnnotateFrame>
    )
  }

  const all = sets.data ?? []
  const ready = all.filter((set) => set.open && set.remaining > 0)
  const waiting = all.filter((set) => !set.open || set.remaining === 0)

  // NOTHING ASSIGNED, or nothing open yet — centred, few words (r6 decision 13).
  if (ready.length === 0) {
    return (
      <AnnotateFrame>
        <Stage title={all.length === 0 ? 'Nothing assigned yet' : 'All caught up'}>
          <p className="m-0 text-muted-foreground">
            {all.length === 0
              ? 'Work appears here when somebody assigns you a set.'
              : `A set opens for annotation when its panel has collected ${ANNOTATION_FLOOR} traces.`}
          </p>
          {waiting.length === 0 ? null : (
            <div className="grid gap-[var(--gap-tight)] text-left">
              {waiting.map((set) => (
                <SetRow key={set.id} set={set} org={search.org} />
              ))}
            </div>
          )}
        </Stage>
      </AnnotateFrame>
    )
  }

  return (
    <AnnotateFrame>
      <Stage title="Annotate traces">
        <div className="grid gap-[var(--gap-tight)] text-left">
          {[...ready, ...waiting].map((set) => (
            <SetRow key={set.id} set={set} org={search.org} />
          ))}
        </div>
      </Stage>
    </AnnotateFrame>
  )
}

type AssignedSet = {
  id: string
  name: string
  panel_name: string
  trace_count: number
  open: boolean
  size: number
  remaining: number
  annotated: number
}

const SetRow = ({ set, org }: { set: AssignedSet; org?: string | undefined }) => {
  const ready = set.open && set.remaining > 0
  const pct = Math.min(100, Math.round((set.trace_count / ANNOTATION_FLOOR) * 100))

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-[var(--gap-inline)] gap-y-[var(--space-2)] rounded-[var(--radius-panel)] border bg-card px-[var(--space-5)] py-[var(--space-4)]">
      <span className="grid">
        <span className="font-semibold">{set.name}</span>
        {/* The panel it came from, so two sets with similar names are still tellable apart. */}
        <span className="text-data text-muted-foreground">{set.panel_name}</span>
      </span>
      {ready ? (
        <span className="flex items-center gap-[var(--gap-inline)]">
          <span className="font-mono text-data text-muted-foreground tabular-nums">
            {set.annotated > 0 ? `${set.annotated} of ${set.size} · ` : ''}
            {set.remaining} left
          </span>
          <Button asChild>
            <Link to="/annotate/$setId" params={{ setId: set.id }} search={{ org }}>
              {set.annotated > 0 ? 'Continue' : 'Start'}
            </Link>
          </Button>
        </span>
      ) : (
        <span className="font-mono text-data text-muted-foreground tabular-nums">
          {set.open ? 'all caught up' : `${set.trace_count} of ${ANNOTATION_FLOOR}`}
        </span>
      )}
      {set.open ? null : (
        // Progress is not a state, so it stays achromatic — the same rule the console's gate
        // card follows (tokens.css rule 4: colour only when the colour is the finding).
        <span
          className="col-span-2 h-[var(--space-1)] overflow-hidden rounded-[var(--radius-pill)] bg-muted"
          role="progressbar"
          aria-valuenow={set.trace_count}
          aria-valuemin={0}
          aria-valuemax={ANNOTATION_FLOOR}
          aria-label={`${set.trace_count} of ${ANNOTATION_FLOOR} traces collected`}
        >
          <span className="block h-full bg-foreground" style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  )
}
