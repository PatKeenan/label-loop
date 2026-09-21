import { ANNOTATION_FLOOR } from '@labelloop/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { reviewPanelsQuery } from '../api/queries.ts'
import { ReviewFrame, Stage } from '../components/review/review-frame.tsx'
import type { ConsoleSearch } from '../components/shell/context.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { Button } from '../components/ui/button.tsx'

/**
 * `/review` — WHERE AN ANNOTATOR LANDS (r6 decision 12).
 *
 * Every panel in the org is listed, including the locked ones: an open panel shows how many
 * traces are waiting, and a locked one shows its progress toward the 50-trace gate. Hiding the
 * locked ones would make a new org's review surface look broken, and naming only the panel
 * closest to opening would hide where the traffic actually is.
 *
 * Counting traces is not an operator signal (ADR-0067 withholds verdicts, confidence, cost and
 * ids), so a count and a bar are what this screen is allowed to say.
 */
export const ReviewHomePage = () => {
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const orgId = context.state === 'ready' ? context.orgId : ''
  const panels = useQuery({ ...reviewPanelsQuery(orgId), enabled: context.state === 'ready' })

  if (context.state === 'pending' || panels.isPending) {
    return (
      <ReviewFrame>
        <Stage title="Loading…" />
      </ReviewFrame>
    )
  }

  if (panels.error !== null) {
    return (
      <ReviewFrame>
        <Stage title="This couldn’t be loaded">
          <p className="m-0 text-muted-foreground">Nothing has been changed. Try again shortly.</p>
        </Stage>
      </ReviewFrame>
    )
  }

  const all = panels.data ?? []
  const open = all.filter((panel) => panel.open && panel.remaining > 0)
  const waiting = all.filter((panel) => !panel.open || panel.remaining === 0)

  // NOTHING OPEN YET — the locked state, centred, with each panel's distance to the gate.
  if (open.length === 0) {
    return (
      <ReviewFrame>
        <Stage title={all.length === 0 ? 'Nothing here yet' : 'Almost ready'}>
          <p className="m-0 text-muted-foreground">
            {all.length === 0
              ? 'This organisation has no panels yet.'
              : `Reviewing opens when a panel has collected ${ANNOTATION_FLOOR} traces.`}
          </p>
          {waiting.length === 0 ? null : (
            <div className="grid gap-[var(--gap-tight)] text-left">
              {waiting.map((panel) => (
                <PanelRow key={panel.slug} panel={panel} org={search.org} />
              ))}
            </div>
          )}
        </Stage>
      </ReviewFrame>
    )
  }

  return (
    <ReviewFrame>
      <Stage title="Review traces">
        <div className="grid gap-[var(--gap-tight)] text-left">
          {[...open, ...waiting].map((panel) => (
            <PanelRow key={panel.slug} panel={panel} org={search.org} />
          ))}
        </div>
        <p className="m-0 text-muted-foreground">
          A panel opens for review at {ANNOTATION_FLOOR} traces.
        </p>
      </Stage>
    </ReviewFrame>
  )
}

type Panel = {
  slug: string
  name: string
  trace_count: number
  open: boolean
  remaining: number
  reviewed: number
}

const PanelRow = ({ panel, org }: { panel: Panel; org?: string | undefined }) => {
  const ready = panel.open && panel.remaining > 0
  const pct = Math.min(100, Math.round((panel.trace_count / ANNOTATION_FLOOR) * 100))

  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-x-[var(--gap-inline)] gap-y-[var(--space-2)] rounded-[var(--radius-panel)] border bg-card px-[var(--space-5)] py-[var(--space-4)]">
      <span className="font-semibold">{panel.name}</span>
      {ready ? (
        <span className="flex items-center gap-[var(--gap-inline)]">
          <span className="font-mono text-data text-muted-foreground tabular-nums">
            {panel.reviewed > 0 ? `${panel.reviewed} reviewed · ` : ''}
            {panel.remaining} waiting
          </span>
          <Button asChild>
            <Link to="/review/$panelSlug" params={{ panelSlug: panel.slug }} search={{ org }}>
              Start
            </Link>
          </Button>
        </span>
      ) : (
        <span className="font-mono text-data text-muted-foreground tabular-nums">
          {panel.open ? 'all caught up' : `${panel.trace_count} of ${ANNOTATION_FLOOR}`}
        </span>
      )}
      {panel.open ? null : (
        // Progress is not a state, so it stays achromatic — the same rule the console's gate
        // card follows (tokens.css rule 4: colour only when the colour is the finding).
        <span
          className="col-span-2 h-[var(--space-1)] overflow-hidden rounded-[var(--radius-pill)] bg-muted"
          role="progressbar"
          aria-valuenow={panel.trace_count}
          aria-valuemin={0}
          aria-valuemax={ANNOTATION_FLOOR}
          aria-label={`${panel.trace_count} of ${ANNOTATION_FLOOR} traces collected`}
        >
          <span className="block h-full bg-foreground" style={{ width: `${pct}%` }} />
        </span>
      )}
    </div>
  )
}
