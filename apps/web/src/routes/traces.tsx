import { can } from '@labelloop/contracts'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useSearch } from '@tanstack/react-router'
import { cn } from 'cn'
import { useState } from 'react'
import { tracePagesQuery, type tracesQuery } from '../api/queries.ts'
import { CreateAnnotationSetDialog } from '../components/shell/annotation-set-dialog.tsx'
import {
  type ConsoleSearch,
  useConsoleContext,
  usePanelContext,
} from '../components/shell/context.ts'
import { Data, Mark } from '../components/shell/mark.tsx'
import { PageHead, panelTrail } from '../components/shell/page-head.tsx'
import { LoadFailed } from '../components/shell/statement.tsx'
import { Button } from '../components/ui/button.tsx'

/**
 * THE TRACE LIST — every row here was written by a real `/v1/panels/{id}/evaluate` call (P4).
 * The console cannot create one; it is the read half of the loop, which is what M0 set out to
 * show end to end and what this phase re-skins without changing.
 *
 * **Traces is the one section never locked** (6b decision 4b): a customer reads their own
 * traffic from the first call, and locking them out of their own data would be a different
 * product.
 *
 * ---
 *
 * **Scoped to the panel open in the URL, by the server** (M4 phase 8). Through phase 7 this
 * list was every trace in the org, with a dashed notice saying so above it — an org's rows
 * under a panel's heading with nothing saying so is the console telling the reader something
 * untrue. `GET /internal/traces` now requires `panel_id`, and the notice and the Panel column
 * went with the org-wide read: every row would have repeated the page's own heading.
 */
/**
 * The table's columns.
 *
 * **`Recorded` was called `Follow-up`, and that meant nothing to anyone reading it** — the
 * stakeholder asked what it was, which is the answer about the label. It is `recorded_at`:
 * the moment the asynchronous `record-evaluation` job ran for this evaluation, `pending`
 * until it has. The word now matches the field on the wire, so the console and the API say
 * the same thing.
 *
 * **Whether it belongs on a CUSTOMER's table at all is a separate question, and it is phase
 * 8's** (open question 2 covers this table's columns). It is here because M0 was proving the
 * async seam works end to end and a null is how a dropped enqueue is found — an operator's
 * signal, not an answer about the caller's evaluation. `jobs/record-evaluation.ts` is candid
 * that stamping this is the job's ONLY effect today; metering (M2) and annotation sampling
 * (M5) are the work it exists to carry later.
 */
/**
 * FIVE columns, down from nine — and the reduction is the fix, not narrower type.
 *
 * Adding the panel and key NAMES took this to nine columns of unbounded text, and every cell
 * began wrapping: "Support reply gate / support-reply-gate" over four lines, rows four times
 * their proper height, and a horizontal scrollbar under the lot. That is the harvest's own Q1
 * arriving on schedule — *ten columns will not fit a laptop viewport* — and it is why the M4
 * plan's open question 2 exists.
 *
 * Two merges rather than two deletions, because no information is actually dropped:
 *
 * - **Score and Threshold become one cell**, `1.00 / 0.50`. A score means nothing without the
 *   bar it is measured against, so they were always one fact read across two columns.
 * - **Recorded folds into Created.** Its only actionable state is `pending` — the follow-up
 *   has not run — so it is a mark beside the timestamp rather than a column of near-identical
 *   times. The exact recorded time is on hover.
 *
 * Then one deletion, when phase 8 scoped the list to a panel: the Panel column, which could
 * only ever repeat the page's heading.
 *
 * Everything is `whitespace-nowrap` and truncates, with the full value in a `title`: a table
 * that reflows its rows to fit long content is a table you cannot scan down.
 */
const COLUMNS: readonly { label: string; title?: string }[] = [
  { label: 'Trace' },
  {
    label: 'Key',
    title:
      'The API key that authorised the call — which client sent it. “deleted” when the key is gone; a trace outlives the credential that made it.',
  },
  {
    label: 'Verdict',
    title:
      'The panel decision. “collecting” means the panel had no judges, so nothing was judged. “partial” means a scoring judge did not run. “annotated” means a person has annotated this trace — open it to read what they said.',
  },
  {
    label: 'Score',
    title:
      'The panel’s score, and the threshold it had to reach. “—” while collecting: a score over zero judges is undefined.',
  },
  {
    label: 'Created',
    title:
      'When the evaluation ran. “pending” means its asynchronous follow-up has not yet — the decision is unaffected either way.',
  },
]

/** Short and local. An ISO string is precise and unreadable in a column you scan down. */
const shortTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })

/**
 * How often the list re-reads while live, in seconds. Chosen by the viewer; 0 is off.
 *
 * POLLING, deliberately — not server-sent events (M4 phase 8, Deviation 74). At a 5–15s cadence
 * polling is one indexed read of one panel's newest page; SSE would need a cross-instance
 * fan-out (a trace is written by whichever API instance served the `/v1` call), long-lived
 * connections through proxies, heartbeats and reconnection — a stack decision, for a need
 * nobody has at seconds-scale latency. TanStack Query already pauses polling in a hidden tab.
 */
const INTERVALS = [0, 5, 10, 15] as const
type Interval = (typeof INTERVALS)[number]

export const TracesPage = () => {
  const queryClient = useQueryClient()
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  const [interval, setRefreshInterval] = useState<Interval>(10)
  /**
   * PICKING TRACES BY HAND, for an annotation set (ADR-0080's `manual`).
   *
   * Component state rather than the URL, unlike every other piece of view state here: this can
   * be 250 ids, and a query string is not where a quarter of a page of identifiers belongs. It
   * is also the one thing on this screen nobody would want back after a reload — a selection is
   * a moment's work, not a view somebody shares.
   */
  const [selected, setSelected] = useState<readonly string[]>([])
  const [creating, setCreating] = useState(false)

  const options = tracePagesQuery(
    context.state === 'ready' ? context.orgId : '',
    panel.state === 'ready' ? panel.id : '',
  )
  const traces = useInfiniteQuery({
    ...options,
    enabled: context.state === 'ready' && panel.state === 'ready',
    // LIVE ONLY AT THE TOP. Refetching an infinite query re-reads EVERY loaded page, so polling
    // someone twenty pages deep would cost twenty reads every tick — and would move the rows
    // they are reading. Once older pages are loaded, live pauses and says so.
    refetchInterval: (query) =>
      interval !== 0 && (query.state.data?.pages.length ?? 1) <= 1 ? interval * 1000 : false,
  })

  if (context.state !== 'ready' || panel.state !== 'ready') return null

  // Only somebody who may CURATE can pick rows for a set, so the column only exists for them
  // (ADR-0083). The server refuses the write either way; this keeps the table from offering it.
  const curates = can(context.role, { annotation: ['curate'] })

  const head = <PageHead scope={panelTrail(context.orgSlug, panel.slug)} title="Traces" />

  if (traces.isPending) {
    return (
      <>
        {head}
        <p className="text-muted-foreground">Loading traces…</p>
      </>
    )
  }

  if (traces.error !== null) {
    return (
      <>
        {head}
        <LoadFailed
          what="Traces"
          error={traces.error}
          onReload={() => void queryClient.invalidateQueries({ queryKey: ['traces'] })}
        />
      </>
    )
  }

  const rows = traces.data.pages.flatMap((page) => page.traces)
  const browsingOlder = traces.data.pages.length > 1

  // Back to the newest page, and live again: keep page one, drop the rest, re-read.
  const backToLatest = () => {
    queryClient.setQueryData(options.queryKey, (data) =>
      data === undefined
        ? data
        : { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) },
    )
    void traces.refetch()
  }

  return (
    <>
      <PageHead
        scope={panelTrail(context.orgSlug, panel.slug)}
        title="Traces"
        actions={
          selected.length > 0 ? (
            // THE SELECTION'S OWN ACTIONS, replacing the live control while a selection exists:
            // the reader has stopped watching the stream and started choosing from it.
            <span className="flex items-center gap-[var(--gap-inline)] text-ui text-muted-foreground">
              {selected.length} selected
              <Button size="sm" variant="outline" onClick={() => setSelected([])}>
                Clear
              </Button>
              <Button size="sm" onClick={() => setCreating(true)}>
                New annotation set
              </Button>
            </span>
          ) : browsingOlder ? (
            <span className="flex items-center gap-[var(--gap-inline)] text-ui text-muted-foreground">
              Live paused while viewing older traces
              <Button size="sm" variant="outline" onClick={backToLatest}>
                Back to latest
              </Button>
            </span>
          ) : (
            <LiveControl value={interval} onChange={setRefreshInterval} />
          )
        }
      />
      {rows.length === 0 ? (
        <p className="text-muted-foreground">
          No traces for {panel.name} yet. Run an evaluation against{' '}
          <code>/v1/panels/{panel.id}/evaluate</code>
          {interval === 0 ? ' and reload.' : ' — they appear here as they arrive.'}
        </p>
      ) : (
        <div className="flex flex-col gap-[var(--gap-stack)]">
          <TraceTable traces={rows} {...(curates ? { selected, onSelect: setSelected } : {})} />
          <div className="flex items-center gap-[var(--gap-inline)]">
            <Data>
              {rows.length} {rows.length === 1 ? 'trace' : 'traces'} shown
            </Data>
            {traces.hasNextPage ? (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() => void traces.fetchNextPage()}
                disabled={traces.isFetchingNextPage}
              >
                {traces.isFetchingNextPage ? 'Loading…' : 'Load older'}
              </Button>
            ) : (
              <span className="ml-auto text-ui text-muted-foreground">
                That’s every trace for this panel.
              </span>
            )}
          </div>
        </div>
      )}

      <CreateAnnotationSetDialog
        open={creating}
        onClose={() => setCreating(false)}
        orgId={context.orgId}
        orgSlug={context.orgSlug}
        panelSlug={panel.slug}
        panelTraceCount={panel.traceCount}
        traceIds={selected}
      />
    </>
  )
}

/**
 * Off / 5s / 10s / 15s — how often the list re-reads while you are at the top of it. The same
 * small segmented buttons as the snippet's language picker, so it reads as a setting of the
 * view rather than as an action.
 */
const LiveControl = ({
  value,
  onChange,
}: {
  value: Interval
  onChange: (value: Interval) => void
}) => (
  <div className="flex items-center gap-[var(--gap-inline)]">
    <span className="text-ui text-muted-foreground">Refresh</span>
    <div role="radiogroup" aria-label="Refresh interval" className="flex gap-[var(--gap-tight)]">
      {INTERVALS.map((option) => (
        <Button
          key={option}
          role="radio"
          aria-checked={option === value}
          size="sm"
          variant={option === value ? 'default' : 'outline'}
          onClick={() => onChange(option)}
        >
          {option === 0 ? 'Off' : `${option}s`}
        </Button>
      ))}
    </div>
  </div>
)

export type TraceRow = Awaited<
  ReturnType<NonNullable<ReturnType<typeof tracesQuery>['queryFn']>>
>[number]

/**
 * The trace table, shared by the Traces section and the Overview's Recent traces — one
 * rendering, so the five rows on the Overview are the same five rows at the top of Traces.
 */
export const TraceTable = ({
  traces,
  selected,
  onSelect,
}: {
  traces: readonly TraceRow[]
  /**
   * WHEN BOTH ARE PRESENT the table grows a checkbox column, for picking an annotation set out
   * of rows an engineer is already reading (plan, phase 4). Absent on the Overview's Recent
   * traces and for anybody who cannot curate — an unusable control is a question the reader has
   * to answer before ignoring.
   */
  selected?: readonly string[]
  onSelect?: (next: readonly string[]) => void
}) => {
  const search = useSearch({ strict: false }) as ConsoleSearch
  const picking = selected !== undefined && onSelect !== undefined
  const allShown = picking && traces.length > 0 && traces.every((t) => selected.includes(t.id))
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-data">
        <thead>
          <tr className="border-b border-border-strong text-left">
            {picking ? (
              <th className="w-[var(--row-min)] px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                <input
                  type="checkbox"
                  aria-label={allShown ? 'Clear selection' : 'Select every trace shown'}
                  checked={allShown}
                  onChange={() =>
                    onSelect(
                      allShown
                        ? selected.filter((id) => !traces.some((t) => t.id === id))
                        : [...new Set([...selected, ...traces.map((t) => t.id)])],
                    )
                  }
                />
              </th>
            ) : null}
            {COLUMNS.map(({ label, title }) => (
              <th
                key={label}
                // A column whose meaning is not obvious from its name says so on hover
                // rather than relying on the reader to already know. `title` is the
                // plainest thing that works on a table head; if more than one column
                // needs a richer explanation, that is phase 8's to design.
                {...(title === undefined ? {} : { title })}
                className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {traces.map((trace) => (
            // The ROW opens the drawer, through a real link in its first cell stretched across the
            // row (`after:absolute after:inset-0`) — so it is keyboard-reachable and announced as
            // a link, with no click handler on a table row. The open row stays highlighted.
            <tr
              key={trace.id}
              className={cn(
                'relative border-b border-border-soft hover:bg-muted',
                search.trace === trace.id && 'bg-muted',
              )}
            >
              {picking ? (
                // OUTSIDE the stretched link's reach, so ticking a row does not also open it:
                // `relative` lifts this cell above the `after:absolute` overlay below.
                <td className="relative z-10 px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle">
                  <input
                    type="checkbox"
                    aria-label={`Select ${trace.id}`}
                    checked={selected.includes(trace.id)}
                    onChange={(event) =>
                      onSelect(
                        event.target.checked
                          ? [...selected, trace.id]
                          : selected.filter((id) => id !== trace.id),
                      )
                    }
                  />
                </td>
              ) : null}
              <Cell>
                <Link
                  to="."
                  search={{ ...search, trace: trace.id }}
                  className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                >
                  <Data className="text-foreground">{trace.id}</Data>
                </Link>
              </Cell>
              <Cell>
                {trace.key_name === null ? (
                  <Data className="text-foreground-faint">deleted</Data>
                ) : (
                  <Data className="block max-w-[10rem] truncate" title={trace.key_name}>
                    {trace.key_name}
                  </Data>
                )}
              </Cell>
              <Cell>
                {/*
                The verdict is the one place on this row that earns colour — rule 4 of the
                approved tokens: ids and numbers stay achromatic, and colour appears only
                where it IS the finding. A NULL verdict is a COLLECTING panel, not a
                failure: nothing was judged, so there is nothing to pass or fail.
              */}
                <span className="flex items-center gap-[var(--gap-tight)]">
                  {trace.passed === null ? (
                    <Mark tone="neutral">collecting</Mark>
                  ) : (
                    <Mark tone={trace.passed ? 'success' : 'fail'}>
                      {trace.passed ? 'pass' : 'fail'}
                    </Mark>
                  )}
                  {/* `complete: false` means a scoring judge did not run, so the score
                    beside it is real but partial — which the verdict alone cannot say. */}
                  {trace.passed !== null && !trace.complete ? (
                    <Mark tone="warning">partial</Mark>
                  ) : null}
                  {/*
                    A PERSON HAS BEEN HERE (M5 phase 6). Achromatic on purpose, beside marks
                    that are not: rule 4 gives colour to the finding, and the finding is what
                    the annotator SAID — which is a sentence, not a chip, and lives in the
                    drawer this row opens. That somebody answered is the row's metadata.

                    Its rule is the QUEUE's: a non-skip answer from anybody. So a marked row
                    is exactly a row that has left the queue, and the two cannot disagree.
                  */}
                  {trace.annotated ? (
                    <Mark tone="neutral" title="A person has annotated this trace">
                      annotated
                    </Mark>
                  ) : null}
                </span>
              </Cell>
              <Cell>
                <Data className="tabular-nums">
                  <span className="text-foreground">
                    {trace.score === null ? '—' : trace.score.toFixed(2)}
                  </span>
                  {' / '}
                  {trace.threshold.toFixed(2)}
                </Data>
              </Cell>
              <Cell>
                <span className="flex items-center gap-[var(--gap-tight)]">
                  <Data title={trace.created_at}>{shortTime(trace.created_at)}</Data>
                  {trace.recorded_at === null ? <Mark tone="neutral">pending</Mark> : null}
                </span>
              </Cell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const Cell = ({ children }: { children: React.ReactNode }) => (
  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle whitespace-nowrap">
    {children}
  </td>
)
