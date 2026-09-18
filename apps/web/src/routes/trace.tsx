import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import { traceDetailQuery } from '../api/queries.ts'
import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { Data } from '../components/shell/mark.tsx'
import { PageHead } from '../components/shell/page-head.tsx'
import { Statement } from '../components/shell/statement.tsx'
import { TraceDetailBody } from '../components/shell/trace-drawer.tsx'

/**
 * ONE TRACE, AS A PAGE — `/p/$panelSlug/traces/$traceId`, the trace's own address.
 *
 * The drawer is the quick look over a list; this is what you send someone (stakeholder,
 * 2026-09-18). The drawer's `?trace=` link already works, but it is a link to "the list, with
 * this open" — this is a link to the trace, with room for what a trace gains later (annotations
 * at M5, judge history after). It renders the SAME body as the drawer, so the two cannot drift.
 *
 * The panel in the URL must be the trace's panel. A trace id pasted under the wrong panel is
 * not found here rather than shown under a heading it does not belong to — the same "a screen
 * may not tell the reader something untrue" rule the org-wide trace notice existed for.
 */
export const TracePage = () => {
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  const { traceId } = useParams({ strict: false }) as { traceId?: string }
  const detail = useQuery({
    ...traceDetailQuery(context.state === 'ready' ? context.orgId : '', traceId ?? ''),
    enabled: context.state === 'ready' && traceId !== undefined,
  })

  if (context.state !== 'ready' || panel.state !== 'ready' || traceId === undefined) return null

  const wrongPanel = detail.data !== undefined && detail.data.panel_id !== panel.id

  return (
    <>
      {/*
        The TRAIL is the way back, every segment a link — not an "All traces" button at the far
        right, where the first version put it and where nobody looks for "up one level".
      */}
      <PageHead
        scope={[
          <Link key="org" to="/" search={{ org: context.orgSlug }}>
            {context.orgSlug}
          </Link>,
          <Link
            key="panel"
            to="/p/$panelSlug"
            params={{ panelSlug: panel.slug }}
            search={{ org: context.orgSlug }}
          >
            {panel.slug}
          </Link>,
          <Link
            key="traces"
            to="/p/$panelSlug/traces"
            params={{ panelSlug: panel.slug }}
            search={{ org: context.orgSlug }}
          >
            traces
          </Link>,
        ]}
        title="Trace"
      />
      {wrongPanel ? (
        <Statement eyebrow="Not available" title="This trace isn’t in this panel">
          <p className="m-0">It doesn’t exist in {panel.name}, or this account can’t see it.</p>
        </Statement>
      ) : (
        <div className="flex w-full max-w-[64rem] flex-col gap-[var(--space-6)]">
          <div className="flex flex-wrap items-baseline gap-[var(--gap-inline)]">
            <Data className="text-foreground break-all select-all">{traceId}</Data>
            {detail.data === undefined ? null : (
              <Data>{new Date(detail.data.created_at).toLocaleString()}</Data>
            )}
          </div>
          <TraceDetailBody traceId={traceId} />
        </div>
      )}
    </>
  )
}
