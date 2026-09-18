import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { traceDetailQuery } from '../../api/queries.ts'
import { ApiError } from '../../errors/api-error.ts'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet.tsx'
import { type ConsoleSearch, useConsoleContext } from './context.ts'
import { Data, Eyebrow, Mark } from './mark.tsx'

/**
 * THE TRACE DRAWER — one trace, whole: what the caller's agent sent, and what each judge said
 * about it (Deviation 75). Opened by `?trace=tr_…` from any row of the trace table, on the
 * Traces section or the Overview, so the list stays where it was underneath.
 *
 * A DRAWER rather than a page because the question it answers is "what is this row?", asked
 * while scanning a list — and a page would lose the scroll position and the live refresh the
 * person was using to find it.
 *
 * **Three sections, in the order a person asks.** Input first: what went in is the thing we
 * never generated and the thing every verdict is about. Then Judges — or, for a COLLECTING
 * panel, a plain statement that none ran, because an empty section would read as missing
 * data. Then the details an engineer uses to go further (the key, the exact panel version,
 * the request id that finds this call's spans).
 *
 * Staff-only, mounted by the shell only for admin and engineer, mirroring the server's
 * `requireRole` on `GET /internal/traces/:id` (it never replaces it).
 */
export const TraceDrawer = () => {
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const navigate = useNavigate()
  const traceId = search.trace
  const orgId = context.state === 'ready' ? context.orgId : ''

  const detail = useQuery({
    ...traceDetailQuery(orgId, traceId ?? ''),
    enabled: context.state === 'ready' && traceId !== undefined,
  })

  // Drops `trace` and keeps everything else, so closing returns to exactly the list underneath.
  const close = () => void navigate({ to: '.', search: { ...search, trace: undefined } })

  return (
    <Sheet open={traceId !== undefined} onOpenChange={(open) => (open ? undefined : close())}>
      <SheetContent
        side="right"
        className="w-full gap-0 overflow-y-auto sm:max-w-[40rem]"
        data-surface="console"
      >
        <SheetHeader className="gap-[var(--gap-inline)] px-[var(--space-8)] pt-[var(--space-8)] pb-[var(--space-6)]">
          <Eyebrow>Trace</Eyebrow>
          <SheetTitle className="font-mono text-ui font-normal break-all select-all">
            {traceId}
          </SheetTitle>
          <SheetDescription asChild>
            <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
              {detail.data === undefined ? null : (
                <>
                  <Decision passed={detail.data.passed} complete={detail.data.complete} />
                  <Data className="tabular-nums">
                    <span className="text-foreground">
                      {detail.data.score === null ? '—' : detail.data.score.toFixed(2)}
                    </span>
                    {' / '}
                    {detail.data.threshold.toFixed(2)}
                  </Data>
                  <Data>{new Date(detail.data.created_at).toLocaleString()}</Data>
                </>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-[var(--space-8)] px-[var(--space-8)] pb-[var(--space-8)]">
          {detail.isPending ? (
            <p className="m-0 text-muted-foreground">Loading…</p>
          ) : detail.error !== null ? (
            <p role="alert" className="m-0 text-body text-muted-foreground">
              {detail.error instanceof ApiError && detail.error.code === 'NOT_FOUND'
                ? 'This trace doesn’t exist, or isn’t in this organisation.'
                : 'This trace couldn’t be loaded. Nothing has been changed.'}
            </p>
          ) : (
            <>
              <Section title="Input">
                <Field label="Artifact">
                  {/* The caller's own output, verbatim — we never generated it (ADR-0019). */}
                  <pre className="m-0 max-h-[24rem] overflow-auto rounded-md border bg-muted px-[var(--pad-field-x)] py-[var(--pad-field-y)] font-mono text-data leading-[var(--leading-snug)] whitespace-pre-wrap break-words">
                    {detail.data.artifact}
                  </pre>
                </Field>
                <Field label="Context">
                  {detail.data.context === null || Object.keys(detail.data.context).length === 0 ? (
                    <span className="text-ui text-muted-foreground">None sent.</span>
                  ) : (
                    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-[var(--gap-stack)] gap-y-[var(--gap-tight)]">
                      {Object.entries(detail.data.context).map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt>
                            <Data>{key}</Data>
                          </dt>
                          <dd className="m-0 font-mono text-data break-words text-foreground">
                            {value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </Field>
              </Section>

              <Section
                title={
                  detail.data.judges.length === 0
                    ? 'Judges'
                    : `Judges · ${detail.data.judges.length}`
                }
              >
                {detail.data.judges.length === 0 ? (
                  <p className="m-0 text-body text-muted-foreground">
                    No judges ran — the panel was collecting when this call arrived. It’s stored,
                    and counts toward annotation.
                  </p>
                ) : (
                  <ul className="m-0 flex list-none flex-col gap-[var(--space-6)] p-0">
                    {detail.data.judges.map((judge) => (
                      <JudgeVerdict key={judge.slug} judge={judge} />
                    ))}
                  </ul>
                )}
              </Section>

              <Section title="Details">
                <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-[var(--gap-stack)] gap-y-[var(--gap-inline)] text-ui">
                  <Detail label="Key">
                    {detail.data.key_name ?? <span className="text-foreground-faint">deleted</span>}
                  </Detail>
                  <Detail label="Panel version">
                    <Data className="text-foreground">v{detail.data.panel_version}</Data>
                  </Detail>
                  <Detail label="Request id">
                    <Data className="text-foreground break-all select-all">
                      {detail.data.request_id}
                    </Data>
                  </Detail>
                  <Detail label="Recorded">
                    {detail.data.recorded_at === null ? (
                      <Mark tone="neutral">pending</Mark>
                    ) : (
                      <Data>{new Date(detail.data.recorded_at).toLocaleString()}</Data>
                    )}
                  </Detail>
                </dl>
              </Section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

type Judge = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof traceDetailQuery>['queryFn']>>>
>['judges'][number]

/**
 * One judge's answer. The RATIONALE is the body — it was written before the verdict (ADR-0019)
 * and it is what a person reads; the verdict is the one coloured mark; everything about HOW it
 * was produced is a single muted line of metadata underneath.
 */
const JudgeVerdict = ({ judge }: { judge: Judge }) => {
  const meta = [
    judge.served_by,
    judge.latency_ms === null ? null : `${judge.latency_ms} ms`,
    judge.attempts > 1 ? `${judge.attempts} attempts` : null,
    judge.input_tokens === null
      ? null
      : `${judge.input_tokens} in / ${judge.output_tokens ?? 0} out`,
    judge.cost_priced && judge.cost_usd !== null ? `$${Number(judge.cost_usd).toFixed(6)}` : null,
    judge.confidence === null ? null : `confidence ${judge.confidence.toFixed(2)}`,
  ].filter((part): part is string => part !== null)

  return (
    <li className="flex flex-col gap-[var(--gap-inline)]">
      <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
        <Data className="text-foreground">{judge.slug}</Data>
        {judge.status !== 'evaluated' ? (
          // Did not answer — skipped, unusable, or unreachable. Never shown as a pass.
          <Mark tone="warning">{judge.status}</Mark>
        ) : (
          <Mark tone={judge.passed ? 'success' : 'fail'}>{judge.passed ? 'pass' : 'fail'}</Mark>
        )}
        <Data className="ml-auto">
          {judge.polarity === 'fails' ? 'true fails' : 'true passes'} · v{judge.version}
        </Data>
      </div>
      <p className="m-0 text-ui text-muted-foreground">{judge.question}</p>
      {judge.rationale === null ? null : <p className="m-0 text-body">{judge.rationale}</p>}
      {judge.reasons.length === 0 ? null : (
        <div className="flex flex-wrap gap-[var(--gap-tight)]">
          {judge.reasons.map((reason) => (
            <Mark key={reason} tone="info">
              {reason}
            </Mark>
          ))}
        </div>
      )}
      {meta.length === 0 ? null : <Data>{meta.join(' · ')}</Data>}
    </li>
  )
}

/** The verdict for the whole call — null is COLLECTING, not a failure (ADR-0060). */
const Decision = ({ passed, complete }: { passed: boolean | null; complete: boolean }) =>
  passed === null ? (
    <Mark tone="neutral">collecting</Mark>
  ) : (
    <span className="flex items-center gap-[var(--gap-tight)]">
      <Mark tone={passed ? 'success' : 'fail'}>{passed ? 'pass' : 'fail'}</Mark>
      {complete ? null : <Mark tone="warning">partial</Mark>}
    </span>
  )

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-[var(--gap-stack)]">
    <h3 className="m-0 text-ui font-semibold">{title}</h3>
    {children}
  </section>
)

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-[var(--gap-inline)]">
    <Eyebrow>{label}</Eyebrow>
    {children}
  </div>
)

const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="contents">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="m-0 min-w-0">{children}</dd>
  </div>
)
