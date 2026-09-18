import { useQuery, useQueryClient } from '@tanstack/react-query'
import { tracesQuery } from '../api/queries.ts'
import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { Data, Mark } from '../components/shell/mark.tsx'
import { PageHead } from '../components/shell/page-head.tsx'
import { LoadFailed } from '../components/shell/statement.tsx'

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
      'The panel decision. “collecting” means the panel had no judges, so nothing was judged. “partial” means a scoring judge did not run.',
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

export const TracesPage = () => {
  const queryClient = useQueryClient()
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  const traces = useQuery({
    ...tracesQuery(
      context.state === 'ready' ? context.orgId : '',
      panel.state === 'ready' ? panel.id : '',
    ),
    enabled: context.state === 'ready' && panel.state === 'ready',
  })

  if (context.state !== 'ready' || panel.state !== 'ready') return null

  const head = <PageHead scope={[context.orgSlug, panel.slug]} title="Traces" />

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

  return (
    <>
      {head}
      {traces.data.length === 0 ? (
        <p className="text-muted-foreground">
          No traces for {panel.name} yet. Run an evaluation against{' '}
          <code>/v1/panels/{panel.id}/evaluate</code> and reload.
        </p>
      ) : (
        <TraceTable traces={traces.data} />
      )}
    </>
  )
}

export type TraceRow = Awaited<
  ReturnType<NonNullable<ReturnType<typeof tracesQuery>['queryFn']>>
>[number]

/**
 * The trace table, shared by the Traces section and the Overview's Recent traces — one
 * rendering, so the five rows on the Overview are the same five rows at the top of Traces.
 */
export const TraceTable = ({ traces }: { traces: readonly TraceRow[] }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-data">
      <thead>
        <tr className="border-b border-border-strong text-left">
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
          <tr key={trace.id} className="border-b border-border-soft">
            <Cell>
              <Data className="text-foreground">{trace.id}</Data>
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

const Cell = ({ children }: { children: React.ReactNode }) => (
  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle whitespace-nowrap">
    {children}
  </td>
)
