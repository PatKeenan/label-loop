import { cn } from 'cn'
import { Fragment } from 'react'
import { Data, Eyebrow } from '../shell/mark.tsx'
import { Markdown } from './markdown.tsx'
import {
  type Call,
  isMessages,
  type Shaped,
  type Step,
  shapeTrace,
  speakerLabel,
  toSteps,
} from './to-steps.ts'

/**
 * ONE TRACE, READ AS IT HAPPENED (ADR-0073). The caller sends its roles in their own shapes;
 * LabelLoop, not the integrator, decides how they read:
 *
 * 1. **Reference**, collapsed — facts the judges had, needed only on demand;
 * 2. **the flow**, in time order — for a chat, one transcript whose next turn is the output;
 *    tool calls as steps between the turns;
 * 3. **the judged surface** — violet, the "a machine is judging this" colour (tokens.css §2),
 *    on the ONE thing judged: the agent's final reply, or its proposal. Never on the calls;
 * 4. **metadata**, one faint line — bookkeeping, not part of the reading.
 *
 * Token-only styling, so the annotator surface (M5 phase 5) can reuse it under
 * `data-surface="annotator"` unchanged.
 */
export const ShapedTrace = ({
  input,
  output,
  reference,
  metadata,
}: {
  input: unknown
  output: unknown
  reference: unknown
  metadata: unknown
}) => {
  const shaped = shapeTrace({ input, output })
  return (
    <div className="flex flex-col gap-[var(--gap-stack)]">
      {isFilled(reference) ? (
        <details className="rounded-md border">
          <summary className="cursor-pointer px-[var(--pad-field-x)] py-[var(--pad-field-y)] text-ui text-muted-foreground select-none">
            Reference
          </summary>
          <div className="border-t px-[var(--pad-field-x)] py-[var(--pad-field-y)]">
            <Value value={reference} />
          </div>
        </details>
      ) : null}

      <Flow shaped={shaped} />

      {isFilled(metadata) ? (
        <Data className="text-foreground-faint">
          {Object.entries(metadata as Record<string, unknown>)
            .map(([key, value]) => `${key} ${String(value)}`)
            .join(' · ')}
        </Data>
      ) : null}
    </div>
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isFilled = (value: unknown): boolean => isRecord(value) && Object.keys(value).length > 0

const Flow = ({ shaped }: { shaped: Shaped }) => {
  switch (shaped.kind) {
    case 'conversation':
      return (
        <ol className="m-0 flex list-none flex-col gap-[var(--gap-inline)] p-0">
          {shaped.steps.map((step, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a transcript never reorders.
            <StepItem key={index} step={step} judged={index === shaped.judged} />
          ))}
          {shaped.judged === null ? (
            <Turn speaker="assistant" judged>
              <p className="m-0 text-body text-muted-foreground italic">No reply was sent.</p>
            </Turn>
          ) : null}
        </ol>
      )
    case 'separate':
      return (
        <>
          <Block label="Input">
            <Value value={shaped.input} />
          </Block>
          <Judged label="Output">
            <Value value={shaped.output} />
          </Judged>
        </>
      )
    case 'legacy':
      return (
        <>
          <p className="m-0 text-ui text-foreground-faint">Recorded before inputs were captured.</p>
          <Judged label="Output">
            <Value value={shaped.output} />
          </Judged>
        </>
      )
  }
}

const StepItem = ({ step, judged }: { step: Step; judged: boolean }) => {
  if (step.kind === 'call') return <CallStep step={step} />
  if (step.kind === 'orphan') {
    return (
      <li className="pl-[var(--space-4)] font-mono text-data text-muted-foreground">
        ↳ result → {compact(step.result)}
      </li>
    )
  }
  if (step.speaker === 'system') {
    // A system prompt is long and the same on every trace: there on demand, not in the way.
    return (
      <li>
        <details className="rounded-md border">
          <summary className="cursor-pointer px-[var(--pad-field-x)] py-[var(--pad-field-y)] text-ui text-muted-foreground select-none">
            System prompt
          </summary>
          <div className="border-t px-[var(--pad-field-x)] py-[var(--pad-field-y)]">
            <Markdown text={step.text} />
          </div>
        </details>
      </li>
    )
  }
  return (
    <Turn speaker={step.speaker} judged={judged}>
      <Markdown text={step.text} />
    </Turn>
  )
}

/** A value on one line, for a step's summary. */
const compact = (value: unknown): string => {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([key, inner]) => `${key}: ${JSON.stringify(inner)}`)
      .join(', ')
  }
  return JSON.stringify(value)
}

/**
 * One tool call: a single line — the call, its arguments, and a one-line result that opens
 * into the whole thing. Evidence for the judged reply, never a turn of its own.
 */
const CallStep = ({ step }: { step: Call }) => (
  <li className="pl-[var(--space-4)]">
    <details>
      <summary className="flex cursor-pointer items-baseline gap-[var(--gap-inline)] font-mono text-data select-none">
        <span className="text-muted-foreground" aria-hidden>
          ↳
        </span>
        <span className="shrink-0 text-foreground">
          {step.name}({compact(step.args)})
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {step.result === undefined ? '→ no result' : `→ ${compact(step.result)}`}
        </span>
      </summary>
      <pre className="m-0 mt-[var(--gap-tight)] ml-[var(--space-5)] rounded-md border px-[var(--pad-field-x)] py-[var(--pad-field-y)] font-mono text-data whitespace-pre-wrap break-words">
        {JSON.stringify({ arguments: step.args, result: step.result }, null, 2)}
      </pre>
    </details>
  </li>
)

const JUDGED_SURFACE =
  'border-info-line bg-info-tint shadow-[inset_var(--border-thick)_0_0_var(--color-info-mark)]'

const BeingJudged = () => <Eyebrow className="ml-auto text-info">Being judged</Eyebrow>

const Turn = ({
  speaker,
  judged,
  children,
}: {
  speaker: string
  judged: boolean
  children: React.ReactNode
}) => (
  <li
    className={cn(
      'flex flex-col gap-[var(--gap-tight)] rounded-md border px-[var(--pad-field-x)] py-[var(--pad-field-y)]',
      judged && JUDGED_SURFACE,
    )}
  >
    <span className="flex items-center gap-[var(--gap-inline)]">
      <Eyebrow>{speakerLabel(speaker)}</Eyebrow>
      {judged ? <BeingJudged /> : null}
    </span>
    {children}
  </li>
)

const Block = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-[var(--gap-inline)] rounded-md border px-[var(--pad-field-x)] py-[var(--pad-field-y)]">
    <Eyebrow>{label}</Eyebrow>
    {children}
  </section>
)

/** A judged output that is not a turn (a proposal, a decision): the output alone, in violet. */
const Judged = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <section
    className={cn(
      'flex flex-col gap-[var(--gap-inline)] rounded-md border px-[var(--pad-field-x)] py-[var(--pad-field-y)]',
      JUDGED_SURFACE,
    )}
  >
    <span className="flex items-center gap-[var(--gap-inline)]">
      <Eyebrow>{label}</Eyebrow>
      <BeingJudged />
    </span>
    {children}
  </section>
)

const humanise = (key: string) =>
  key.replace(/[_-]+/g, ' ').replace(/^\w/, (first) => first.toUpperCase())

/** Render by SHAPE: text as markdown, a transcript as steps, an object as fields, else JSON. */
const Value = ({ value }: { value: unknown }): React.ReactNode => {
  if (typeof value === 'string') return <Markdown text={value} />
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return <Data className="text-foreground">{String(value)}</Data>
  }
  if (isMessages(value)) {
    const steps = toSteps(value) ?? []
    return (
      <ol className="m-0 flex list-none flex-col gap-[var(--gap-inline)] p-0">
        {steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a transcript never reorders.
          <StepItem key={index} step={step} judged={false} />
        ))}
      </ol>
    )
  }
  if (isRecord(value)) {
    return (
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-[var(--gap-stack)] gap-y-[var(--gap-inline)]">
        {Object.entries(value).map(([key, inner]) => (
          <Fragment key={key}>
            <dt className="text-ui text-muted-foreground">{humanise(key)}</dt>
            <dd className="m-0 min-w-0 text-body">
              <Value value={inner} />
            </dd>
          </Fragment>
        ))}
      </dl>
    )
  }
  return (
    <pre className="m-0 font-mono text-data whitespace-pre-wrap break-words">
      {JSON.stringify(value, null, 2)}
    </pre>
  )
}
