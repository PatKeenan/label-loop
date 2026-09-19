import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { cn } from 'cn'
import {
  ArrowDownToLineIcon,
  ArrowUpFromLineIcon,
  ChevronRightIcon,
  Maximize2Icon,
} from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
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
 * `requirePermission` on `GET /internal/traces/:id` (it never replaces it).
 */
export const TraceDrawer = () => {
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const navigate = useNavigate()
  const traceId = search.trace
  const { panelSlug } = useParams({ strict: false }) as { panelSlug?: string }
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
        {/*
          OPEN AS PAGE — beside the close button. The drawer is the quick look; the trace's own
          page is what you send someone, and is where full width lives. `?trace=` is dropped on
          the way, so Back from the page returns to the list rather than re-opening the drawer.
        */}
        {panelSlug === undefined || traceId === undefined ? null : (
          <Link
            to="/p/$panelSlug/traces/$traceId"
            params={{ panelSlug, traceId }}
            search={{ org: search.org }}
            aria-label="Open as page"
            title="Open as page"
            className="absolute top-4 right-12 rounded-xs text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-hidden"
          >
            <Maximize2Icon className="size-4" />
          </Link>
        )}
        <SheetHeader className="gap-[var(--gap-inline)] px-[var(--space-8)] pt-[var(--space-8)] pb-[var(--space-6)]">
          <Eyebrow>Trace</Eyebrow>
          <SheetTitle className="font-mono text-ui font-normal break-all select-all">
            {traceId}
          </SheetTitle>
          <SheetDescription asChild>
            <div>
              {detail.data === undefined ? null : (
                <Data>{new Date(detail.data.created_at).toLocaleString()}</Data>
              )}
            </div>
          </SheetDescription>
        </SheetHeader>

        <div className="px-[var(--space-8)] pb-[var(--space-8)]">
          {traceId === undefined ? null : <TraceDetailBody traceId={traceId} />}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * THE TRACE, WHOLE — Request, Response, Details. ONE component, rendered by the drawer (the
 * quick look over a list) and by the trace page (the trace's own address), so the two cannot
 * drift into different accounts of the same record.
 */
export const TraceDetailBody = ({ traceId }: { traceId: string }) => {
  const context = useConsoleContext()
  const orgId = context.state === 'ready' ? context.orgId : ''
  const detail = useQuery({
    ...traceDetailQuery(orgId, traceId),
    enabled: context.state === 'ready',
  })
  const reference = detail.data?.reference ?? null
  const referenceCount = reference === null ? 0 : Object.keys(reference).length

  return (
    <div className="flex flex-col gap-[var(--space-8)]">
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
          {/*
          IN, then OUT — two bordered blocks with a DIRECTION, because the first draft set
          both at one level and a reader could not tell what was sent from what came back.
          Borders and direction do the separating, not a new fill (a lighter surface on
          dark reads as a raised slab — the lesson of the create dialog's footer band).
        */}
          <section className="rounded-lg border">
            <div className="flex items-start gap-[var(--gap-inline)] px-[var(--space-5)] py-[var(--space-4)]">
              <BlockTitle
                icon={<ArrowDownToLineIcon className="size-4" />}
                title="Request"
                caption="What your agent sent"
              />
            </div>
            <div className="flex flex-col gap-[var(--gap-stack)] border-t px-[var(--space-5)] py-[var(--space-5)]">
              {/*
                STOPGAP (ADR-0074): the four roles shown as text until the shaped view replaces
                this block — output, then its input, then the reference, each as the caller's
                own JSON. A LEGACY row never recorded an input, and says so.
              */}
              <Field label="Output">
                {/* The caller's own output — we never generated it (ADR-0019). Clamped,
                  because nothing bounds how long it is. */}
                <Clamped
                  key={`${traceId}-output`}
                  what="text"
                  lines={lineCount(asText(detail.data.output))}
                >
                  <Verbatim>{asText(detail.data.output)}</Verbatim>
                </Clamped>
              </Field>
              <Field label="Input">
                {detail.data.input === null ? (
                  <span className="text-ui text-muted-foreground">
                    Recorded before inputs were captured.
                  </span>
                ) : (
                  <Clamped
                    key={`${traceId}-input`}
                    what="text"
                    lines={lineCount(asText(detail.data.input))}
                  >
                    <Verbatim>{asText(detail.data.input)}</Verbatim>
                  </Clamped>
                )}
              </Field>
              <Field label="Reference">
                {reference === null || referenceCount === 0 ? (
                  <span className="text-ui text-muted-foreground">None sent.</span>
                ) : (
                  <Clamped key={`${traceId}-reference`} what="fields" keys={referenceCount}>
                    <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-[var(--gap-stack)] gap-y-[var(--gap-tight)]">
                      {Object.entries(reference).map(([key, value]) => (
                        <div key={key} className="contents">
                          <dt>
                            <Data>{key}</Data>
                          </dt>
                          <dd className="m-0 font-mono text-data break-words whitespace-pre-wrap text-foreground">
                            {asText(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </Clamped>
                )}
              </Field>
            </div>
          </section>

          <section className="rounded-lg border">
            <div className="flex items-start gap-[var(--gap-inline)] px-[var(--space-5)] py-[var(--space-4)]">
              <BlockTitle
                icon={<ArrowUpFromLineIcon className="size-4" />}
                title="Response"
                caption="What the panel returned"
              />
              {/* The DECISION leads the response — it is output, and it used to sit in the
                header beside the trace id as though it were a property of the call. */}
              <span className="ml-auto flex items-center gap-[var(--gap-inline)]">
                <Decision passed={detail.data.passed} complete={detail.data.complete} />
                <Data className="tabular-nums">
                  <span className="text-foreground">
                    {detail.data.score === null ? '—' : detail.data.score.toFixed(2)}
                  </span>
                  {' / '}
                  {detail.data.threshold.toFixed(2)}
                </Data>
              </span>
            </div>
            <div className="flex flex-col gap-[var(--gap-stack)] border-t px-[var(--space-5)] py-[var(--space-5)]">
              <Eyebrow>
                {detail.data.judges.length === 0
                  ? 'Judges'
                  : `Judges · ${detail.data.judges.length}`}
              </Eyebrow>
              {detail.data.judges.length === 0 ? (
                <p className="m-0 text-body text-muted-foreground">
                  No judges ran — the panel was collecting when this call arrived. It’s stored, and
                  counts toward annotation.
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-[var(--space-6)] p-0">
                  {detail.data.judges.map((judge) => (
                    <JudgeVerdict key={judge.slug} judge={judge} />
                  ))}
                </ul>
              )}
            </div>
          </section>

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

const lineCount = (text: string) => text.split('\n').length

/** A role as text: a string verbatim, anything else as indented JSON (a stopgap, ADR-0074). */
const asText = (value: unknown): string =>
  // `JSON.stringify(undefined)` returns undefined despite its type — and an API older than the
  // console (one not restarted after the route changed) sends no `output` at all.
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '')

const Verbatim = ({ children }: { children: string }) => (
  <pre className="m-0 rounded-md border bg-muted px-[var(--pad-field-x)] py-[var(--pad-field-y)] font-mono text-data leading-[var(--leading-snug)] whitespace-pre-wrap break-words">
    {children}
  </pre>
)

/**
 * CONTENT OF UNKNOWN LENGTH, clamped — the trace's roles are the caller's own data,
 * and nothing bounds them. Shown at up to `--clamp` tall with the bottom edge faded out, and a
 * **Show all** control ONLY if it actually overflows: a one-line artifact gets no toggle, because
 * a control that does nothing is noise.
 *
 * The fade is a MASK (transparency), not a gradient of a colour, so it needs no colour the
 * approved palette lacks and works on whatever surface it sits on. Keyed by trace at the call
 * site, so opening another trace starts clamped again.
 */
const Clamped = ({
  what,
  lines,
  keys,
  children,
}: {
  what: 'text' | 'fields'
  lines?: number
  keys?: number
  children: React.ReactNode
}) => {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Measured, not guessed from length: wrapping makes "how tall" a question for the layout.
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const clamped = !expanded
  const size =
    what === 'text'
      ? `${lines ?? 0} ${lines === 1 ? 'line' : 'lines'}`
      : `${keys ?? 0} ${keys === 1 ? 'key' : 'keys'}`

  return (
    <div className="flex flex-col gap-[var(--gap-inline)]">
      <div
        ref={ref}
        className={cn(
          clamped && 'max-h-[12rem] overflow-hidden',
          clamped && overflows && '[mask-image:linear-gradient(to_bottom,black_65%,transparent)]',
        )}
      >
        {children}
      </div>
      {overflows || expanded ? (
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex items-center gap-[var(--gap-tight)] self-start text-ui text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn('size-4 transition-transform', expanded && 'rotate-90')}
          />
          {expanded ? 'Show less' : `Show all · ${size}`}
        </button>
      ) : null}
    </div>
  )
}

/** A block's heading: its direction icon, a title, and what it means in plain words. */
const BlockTitle = ({
  icon,
  title,
  caption,
}: {
  icon: React.ReactNode
  title: string
  caption: string
}) => (
  <span className="flex items-start gap-[var(--gap-inline)]">
    <span aria-hidden className="mt-0.5 text-muted-foreground">
      {icon}
    </span>
    <span className="flex flex-col gap-[var(--gap-tight)]">
      <span className="text-ui font-semibold">{title}</span>
      <span className="text-ui text-muted-foreground">{caption}</span>
    </span>
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
