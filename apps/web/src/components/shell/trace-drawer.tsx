import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { ArrowDownToLineIcon, ArrowUpFromLineIcon, Maximize2Icon, UserIcon } from 'lucide-react'
import { traceDetailQuery } from '../../api/queries.ts'
import { ApiError } from '../../errors/api-error.ts'
import { ShapedTrace } from '../shaped/shaped-trace.tsx'
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
 * **Four sections, in the order a person asks.** Input first: what went in is the thing we
 * never generated and the thing every verdict is about. Then Judges — or, for a COLLECTING
 * panel, a plain statement that none ran, because an empty section would read as missing
 * data. Then Annotations: what the people who read it said (M5 phase 6). Then the details an
 * engineer uses to go further (the key, the exact panel version, the request id that finds
 * this call's spans).
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
 * THE TRACE, WHOLE — Request, Response, Annotations, Details. ONE component, rendered by the
 * drawer (the quick look over a list) and by the trace page (the trace's own address), so the
 * two cannot drift into different accounts of the same record. The annotations block is here
 * rather than on the page alone for that reason: the trace page's own comment says annotations
 * are what it gains at M5, and one body is how both get them at once.
 */
export const TraceDetailBody = ({ traceId }: { traceId: string }) => {
  const context = useConsoleContext()
  const orgId = context.state === 'ready' ? context.orgId : ''
  const detail = useQuery({
    ...traceDetailQuery(orgId, traceId),
    enabled: context.state === 'ready',
  })

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
            <div className="border-t px-[var(--space-5)] py-[var(--space-5)]">
              {/* The caller's roles, by shape and in time order (ADR-0073) — we generated
                none of them (ADR-0019). */}
              <ShapedTrace
                input={detail.data.input}
                output={detail.data.output}
                reference={detail.data.reference}
                metadata={detail.data.metadata}
              />
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

          {/*
            WHAT PEOPLE SAID — after the panel's answer, because that is the order the
            question is asked in: here is what the machine decided, and here is what a person
            who read it thinks. It is the read half of the loop M6 authors judges from.
          */}
          <Annotations annotations={detail.data.annotations} />

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

type Detail = NonNullable<
  Awaited<ReturnType<NonNullable<ReturnType<typeof traceDetailQuery>['queryFn']>>>
>
type Annotation = Detail['annotations'][number]

/**
 * THE ANNOTATIONS BLOCK (M5 phase 6) — one entry per person who has answered this trace.
 *
 * **It is rendered even when empty**, saying so in a line. An absent section would leave a
 * reader unable to tell "nobody has reviewed this" from "this console does not show that",
 * and the first is a fact worth knowing while a panel is collecting.
 *
 * The OUTCOME earns the colour and the NOTE is the body, the same shape as a judge's verdict
 * directly above — an annotation is the human answer to the same question, and rendering the
 * two alike is what makes M6's comparison of them legible.
 */
export const Annotations = ({ annotations }: { annotations: readonly Annotation[] }) => (
  <section className="flex flex-col gap-[var(--gap-stack)]">
    <Eyebrow>
      {annotations.length === 0 ? 'Annotations' : `Annotations · ${annotations.length}`}
    </Eyebrow>
    {annotations.length === 0 ? (
      <p className="m-0 text-body text-muted-foreground">Nobody has reviewed this trace yet.</p>
    ) : (
      <ul className="m-0 flex list-none flex-col gap-[var(--space-6)] p-0">
        {annotations.map((annotation) => (
          <AnnotationRow key={annotation.id} annotation={annotation} />
        ))}
      </ul>
    )}
  </section>
)

/**
 * One person's answer. The name is the person's own, with their address on hover: contribution
 * attaches to the PERSON and outlives their membership (ADR-0066), so this is whoever did the
 * work whether or not they are still in the org.
 *
 * `revisions` above zero is a CHANGED MIND, said plainly. The table is append-only, so the
 * earlier answers are still there — what this screen shows is the current one, and staying
 * silent about the others would be the screen deciding they did not happen.
 */
const AnnotationRow = ({ annotation }: { annotation: Annotation }) => (
  <li className="flex flex-col gap-[var(--gap-inline)]">
    <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
      <span aria-hidden className="text-muted-foreground">
        <UserIcon className="size-4" />
      </span>
      <span className="text-ui" title={annotation.annotator_email}>
        {annotation.annotator_name === '' ? annotation.annotator_email : annotation.annotator_name}
      </span>
      <Outcome outcome={annotation.outcome} />
      {annotation.revisions === 0 ? null : (
        <Data title={`${annotation.revisions + 1} answers from this person, oldest kept`}>
          changed{annotation.revisions > 1 ? ` ${annotation.revisions}×` : ''}
        </Data>
      )}
      <Data className="ml-auto" title={annotation.created_at}>
        {new Date(annotation.created_at).toLocaleString()}
      </Data>
    </div>
    {annotation.note === null ? null : <p className="m-0 text-body">{annotation.note}</p>}
  </li>
)

/**
 * The three outcomes, in the words the annotator was shown (ADR-0066). A SKIP is not a
 * failure and is not a pass — it is "I cannot judge this", which is why it is neutral: it
 * says something about the pairing of person and trace, not about the output.
 */
const Outcome = ({ outcome }: { outcome: Annotation['outcome'] }) =>
  outcome === 'skipped' ? (
    <Mark tone="neutral">skipped</Mark>
  ) : (
    <Mark tone={outcome === 'acceptable' ? 'success' : 'fail'}>
      {outcome === 'acceptable' ? 'acceptable' : 'not acceptable'}
    </Mark>
  )

type Judge = Detail['judges'][number]

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

const Detail = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="contents">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="m-0 min-w-0">{children}</dd>
  </div>
)
