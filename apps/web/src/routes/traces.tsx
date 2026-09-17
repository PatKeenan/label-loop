import { useQuery, useQueryClient } from '@tanstack/react-query'
import { tracesQuery } from '../api/queries.ts'
import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { Data, Mark } from '../components/shell/mark.tsx'
import { ContentSlot, PageHead } from '../components/shell/page-head.tsx'
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
 * **THIS TABLE IS STILL ORG-WIDE, AND IT SAYS SO ON THE SCREEN.**
 *
 * `GET /internal/traces` takes no panel filter. CONSOLE_FLOW §3 and §4 give phase 8 the job of
 * scoping it, on the reasoning that the API is shaped the easy way round — it is org-wide
 * today, so phase 8 narrows it rather than widening anything. Phase 7's job was to prove the
 * token conversion and the shell on a REAL screen with real data before the panel screens
 * depend on both, and this is that screen.
 *
 * The notice is not decoration and it is not a TODO comment. An org's rows under a panel's
 * heading, with nothing saying so, is the console telling the reader something untrue —
 * which is the one thing a screen in this project may not do. It is drawn in the same dashed
 * language as an unbuilt screen so it reads as scaffolding rather than as product, and it
 * goes away in phase 8 along with the org-wide read.
 */
export const TracesPage = () => {
  const queryClient = useQueryClient()
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  const traces = useQuery({
    ...tracesQuery(context.state === 'ready' ? context.orgId : ''),
    enabled: context.state === 'ready',
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
      <ContentSlot label="Not yet scoped · phase 8" className="min-h-0 flex-none">
        <p className="m-0">
          These are every trace in <strong>{context.orgSlug}</strong>, not only{' '}
          <strong>{panel.slug}</strong>’s. <code>GET /internal/traces</code> takes no panel filter
          yet; phase 8 scopes it and this notice goes with it.
        </p>
      </ContentSlot>

      {traces.data.length === 0 ? (
        <p className="text-muted-foreground">
          No traces yet. Run an evaluation against <code>/v1</code> and reload.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-data">
            <thead>
              <tr className="border-b border-border-strong text-left">
                {['Trace', 'Panel', 'Verdict', 'Score', 'Threshold', 'Follow-up', 'Created'].map(
                  (column) => (
                    <th
                      key={column}
                      className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
                    >
                      {column}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {traces.data.map((trace) => (
                <tr key={trace.id} className="border-b border-border-soft">
                  <Cell>
                    <Data className="text-foreground">{trace.id}</Data>
                  </Cell>
                  <Cell>
                    <Data>{trace.panel_id}</Data>
                  </Cell>
                  <Cell>
                    {/*
                      The verdict is the one place on this row that earns colour — rule 4 of
                      the approved tokens: numbers and ids stay achromatic, and colour appears
                      only where it IS the finding. `complete: false` means a scoring judge did
                      not run, so the score beside it is real but PARTIAL, which the panel
                      decision alone cannot show — so it rides here as a second mark rather
                      than as a column of yes/no nobody can interpret.
                    */}
                    <span className="flex items-center gap-[var(--gap-tight)]">
                      <Mark tone={trace.passed ? 'success' : 'fail'}>
                        {trace.passed ? 'pass' : 'fail'}
                      </Mark>
                      {trace.complete ? null : <Mark tone="warning">partial</Mark>}
                    </span>
                  </Cell>
                  <Cell>
                    <Data className="text-foreground">{trace.score.toFixed(2)}</Data>
                  </Cell>
                  <Cell>
                    <Data>{trace.threshold.toFixed(2)}</Data>
                  </Cell>
                  <Cell>
                    {/* Null until the P5 queue job has stamped it. Visible because "the async
                        follow-up ran" is one of the things M0 is claiming works. */}
                    {trace.recorded_at === null ? (
                      <Mark tone="neutral">pending</Mark>
                    ) : (
                      <Data>{trace.recorded_at}</Data>
                    )}
                  </Cell>
                  <Cell>
                    <Data>{trace.created_at}</Data>
                  </Cell>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

const Cell = ({ children }: { children: React.ReactNode }) => (
  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle">{children}</td>
)
