import { useQuery } from '@tanstack/react-query'
import { LockIcon } from 'lucide-react'
import { panelQuery } from '../api/queries.ts'
import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { Gate } from '../components/shell/gate.tsx'
import { issuedKeyFor } from '../components/shell/issued-key.ts'
import { Data, Eyebrow, Mark } from '../components/shell/mark.tsx'
import { PageHead } from '../components/shell/page-head.tsx'
import { Snippet } from '../components/shell/snippet.tsx'
import { Statement } from '../components/shell/statement.tsx'

/**
 * The scope line and title every panel section shares. The shell has already resolved the
 * panel by the time a section renders — `ConsoleLayout` draws the not-found and failed
 * states itself — so a section that gets here has one.
 */
const usePanel = () => {
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  if (context.state !== 'ready' || panel.state !== 'ready') return null
  return { orgId: context.orgId, orgSlug: context.orgSlug, panel }
}

/**
 * A PANEL'S OVERVIEW — its home, and at M4 its onboarding.
 *
 * The order is the decision (6c decision 2): state, then the snippet, then progress toward
 * the gate — **what to do, how to do it, what it unlocks**. Nothing else on the panel is
 * dressed up as available, because nothing else IS: judges are locked until an eval pass
 * exists (ADR-0061) and annotation arrives at M5.
 *
 * This section is live at M4 rather than M6 because ADR-0060 moved into M4 during the phase 6
 * review, and a panel opens here rather than on a judge list (Deviations 39–41).
 */
export const PanelOverviewPage = () => {
  const resolved = usePanel()
  const read = useQuery({
    ...panelQuery(resolved?.orgId ?? '', resolved?.panel.slug ?? ''),
    enabled: resolved !== null,
  })

  if (resolved === null) return null
  const { orgSlug, panel } = resolved

  const head = <PageHead scope={[orgSlug, panel.slug]} title="Overview" />
  if (read.isPending) {
    return (
      <>
        {head}
        <p className="text-muted-foreground">Loading…</p>
      </>
    )
  }
  if (read.error !== null || read.data === undefined) {
    return (
      <>
        {head}
        <Statement tone="fail" title="This panel couldn’t be loaded">
          <p className="m-0">Nothing has been changed.</p>
        </Statement>
      </>
    )
  }

  const data = read.data
  const collecting = data.state === 'collecting'

  return (
    <>
      <PageHead
        scope={[orgSlug, panel.slug]}
        title="Overview"
        actions={<Mark tone={collecting ? 'neutral' : 'success'}>{data.state}</Mark>}
      />

      {collecting ? <Gate traceCount={data.trace_count} /> : null}

      {/*
        The key is shown only on the visit that CREATED this panel. It is held in memory by
        the create flow and never re-fetched, because it is never stored — see `issued-key.ts`.
        On any later visit the snippet renders with a placeholder and says where to get one.
      */}
      <Snippet panelId={data.id} apiKey={issuedKeyFor(data.id)} />

      {collecting ? null : (
        <section className="flex flex-col gap-[var(--gap-inline)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
          <Eyebrow>This panel judges</Eyebrow>
          <p className="m-0 text-body">
            {data.judges.length} {data.judges.length === 1 ? 'judge' : 'judges'} convene on every
            call, and the panel passes at a score of {data.threshold ?? 0}.
          </p>
          <Data>{data.trace_count} traces captured</Data>
        </section>
      )}
    </>
  )
}

/**
 * JUDGES — read-only at M4, and LOCKED until an eval pass exists.
 *
 * **The lock is about the audit trail, not pedagogy** (ADR-0061). A judge must cite the
 * traces and annotations that produced it, because alignment scores, the contribution ledger
 * and the audit log all rest on *which traces, annotated by whom, led to this judge*. A
 * free-form judge severs that chain at its origin and nothing later repairs it.
 *
 * A padlock, not a milestone mark: this section is BUILT and not yours yet, which is a
 * different statement from "not built" and gets a different mark (6c decision 5).
 */
export const PanelJudgesPage = () => {
  const resolved = usePanel()
  const read = useQuery({
    ...panelQuery(resolved?.orgId ?? '', resolved?.panel.slug ?? ''),
    enabled: resolved !== null,
  })

  if (resolved === null || read.data === undefined) return null
  const { orgSlug, panel } = resolved
  const judges = read.data.judges

  return (
    <>
      <PageHead scope={[orgSlug, panel.slug]} title="Judges" />

      <section className="flex max-w-[var(--measure)] flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
        <div className="flex items-center gap-[var(--gap-inline)]">
          <LockIcon aria-hidden className="size-4 text-muted-foreground" />
          <h2 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">
            Authoring is locked
          </h2>
        </div>
        <p className="m-0 text-body">
          A judge has to cite the traces and annotations that produced it — that link is what makes
          an alignment score mean something later. So judges are written from an eval pass, never
          from a blank form.
        </p>
        <p className="m-0 text-body text-muted-foreground">
          What opens it: collect traces, have an expert annotate them, cluster those notes into a
          taxonomy, and author a judge from a category. <strong>Traces are never locked</strong> —
          you can read everything this panel has captured from the first call.
        </p>
      </section>

      {judges.length === 0 ? (
        <p className="text-muted-foreground">
          This panel has no judges yet, which is the normal state of a new panel.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-data">
            <thead>
              <tr className="border-b border-border-strong text-left">
                {['Judge', 'Question', 'Polarity', 'Weight', 'Required', 'Model'].map((column) => (
                  <th
                    key={column}
                    className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {judges.map((judge) => (
                // Deliberately NOT a link at M4: a judge's own page — its traces, its
                // alignment — is recorded as direction and deferred (CONSOLE_FLOW R8).
                <tr key={judge.judge_id} className="border-b border-border-soft">
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    <Data className="text-foreground">{judge.slug}</Data>
                  </td>
                  <td className="max-w-[var(--measure)] px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    {judge.question}
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    {/* Two-valued, and which one it is decides whether `true` passes or
                        fails — without it the panel score is uncomputable (ADR-0034). */}
                    <Mark tone="info">{judge.polarity}</Mark>
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    <Data>{judge.weight}</Data>
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    {judge.required ? <Mark tone="warning">veto</Mark> : <Data>—</Data>}
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    <Data>{judge.model ?? '—'}</Data>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}
