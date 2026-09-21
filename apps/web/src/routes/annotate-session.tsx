import { ANNOTATION_FLOOR, ANNOTATION_NOTE_MAX_LENGTH } from '@labelloop/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { cn } from 'cn'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.ts'
import { annotateNextQuery, annotatePreviousQuery, assignedSetsQuery } from '../api/queries.ts'
import { AnnotateFrame, Stage } from '../components/annotate/annotate-frame.tsx'
import {
  type Answer,
  answerBody,
  canSave,
  keyToAction,
  noteRequired,
} from '../components/annotate/answer-state.ts'
import { ShapedTrace } from '../components/shaped/shaped-trace.tsx'
import type { ConsoleSearch } from '../components/shell/context.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { Button } from '../components/ui/button.tsx'
import { apiErrorFrom } from '../errors/api-error.ts'

/**
 * `/annotate/$setId` — ONE TRACE, ONE QUESTION, out of an ASSIGNED SET (r6, ADR-0066,
 * ADR-0079).
 *
 * The trace is drawn by `ShapedTrace`, the SAME component the console's drawer uses: reference
 * collapsed, the flow in time order, tool calls as steps, and only the final reply or proposal
 * on the violet surface. Two views of one trace that could disagree would be two accounts of
 * what was judged.
 *
 * **`metadata` is not passed**, because the payload does not carry it (ADR-0077) — the
 * component renders nothing for it, and there is nothing here to withhold.
 *
 * Keyboard-first: Y / N / S choose, Enter saves. The answer is SELECTED and then saved rather
 * than saved on the first key (r6 Q3), so a mis-key is recoverable before it becomes a row.
 */
type PreviousItem = Extract<
  NonNullable<
    Awaited<ReturnType<NonNullable<ReturnType<typeof annotatePreviousQuery>['queryFn']>>>
  >,
  { state: 'item' }
>

/** The words a person used, not the enum they landed in. */
const OUTCOME_WORDS: Record<string, string> = {
  acceptable: 'acceptable',
  not_acceptable: 'not acceptable',
  skipped: 'skip',
}

export const AnnotateSessionPage = () => {
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const { setId } = useParams({ strict: false }) as { setId: string }
  const orgId = context.state === 'ready' ? context.orgId : ''

  /** Advancing the queue is an explicit step, not a refetch — see `annotateNextQuery`. */
  const [nonce, setNonce] = useState(0)
  /**
   * ONE STEP BACK, and only one (stakeholder, 2026-09-20). Holding the item rather than a flag
   * because the queue has already moved on: this is the trace you just answered, fetched back.
   * Answering it again writes a NEW row — the table is append-only, and the latest row for the
   * pair is what a reader takes.
   */
  const [undo, setUndo] = useState<PreviousItem | null>(null)
  const [answer, setAnswer] = useState<Answer>(null)
  const [note, setNote] = useState('')
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const item = useQuery({
    ...annotateNextQuery(orgId, setId, nonce),
    enabled: context.state === 'ready',
  })

  const previous = useQuery({ ...annotatePreviousQuery(orgId, setId), enabled: false })

  /**
   * The set's NAME, for the header. Taken from the assigned list rather than added to the item
   * payload: the list is already warm from the landing page, and the item payload's job is to
   * carry as little as it can (ADR-0067). The id is the fallback, never a blank.
   */
  const sets = useQuery({ ...assignedSetsQuery(orgId), enabled: context.state === 'ready' })
  const setName = sets.data?.find((set) => set.id === setId)?.name ?? setId

  const data = item.data
  /** What is on screen: the step-back item if there is one, otherwise the queue's. */
  const shownItem = undo ?? (data?.state === 'item' ? data : null)
  const itemId = shownItem?.item_id

  const save = useMutation({
    mutationFn: async (body: ReturnType<typeof answerBody>) => {
      const response = await api.internal.annotate.sets[':id'].annotations.$post(
        { param: { id: setId }, json: body },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: () => {
      setAnswer(null)
      setNote('')
      // Back to the live queue either way: answering the previous item again is a correction,
      // not a place to stay.
      setUndo(null)
      setNonce((value) => value + 1)
    },
  })

  const submit = useCallback(() => {
    if (itemId === undefined || answer === null || !canSave(answer, note)) return
    if (save.isPending) return
    save.mutate(answerBody(itemId, answer, note))
  }, [answer, itemId, note, save])

  const choose = useCallback((next: Answer) => {
    setAnswer(next)
    if (next !== 'not_acceptable') return
    // The note is the whole point of "not acceptable", so the cursor goes there without asking.
    requestAnimationFrame(() => noteRef.current?.focus())
  }, [])

  const stepBack = useCallback(async () => {
    const result = await previous.refetch()
    const last = result.data
    if (last === undefined || last.state !== 'item') return
    setUndo(last)
    setAnswer(null)
    setNote('')
  }, [previous])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'
      const action = keyToAction(event)
      if (action === null) return
      // While typing a note, only Enter means anything — and only with a modifier-free press,
      // because a note is prose and Shift+Enter is how a person writes a second line.
      if (typing) {
        if (action === 'save' && !event.shiftKey) {
          event.preventDefault()
          submit()
        }
        return
      }
      event.preventDefault()
      if (action === 'save') submit()
      else choose(action)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [choose, submit])

  if (context.state === 'pending' || item.isPending) {
    return (
      <AnnotateFrame>
        <Stage title="Loading…" />
      </AnnotateFrame>
    )
  }

  if (item.error !== null || data === undefined) {
    return (
      <AnnotateFrame>
        <Stage title="This couldn’t be loaded">
          <p className="m-0 text-muted-foreground">Nothing has been recorded. Try again shortly.</p>
          <BackToSets org={search.org} />
        </Stage>
      </AnnotateFrame>
    )
  }

  // The step-back item OUTLIVES these states: finishing a panel and then spotting a mis-key
  // is exactly when a person wants it back, and `drained` would otherwise swallow the screen.
  if (undo === null) {
    if (data.state === 'locked') {
      return (
        <AnnotateFrame>
          <Stage title="Almost ready">
            <p className="m-0 text-muted-foreground">
              This set’s panel has collected {data.trace_count} traces. Annotating opens at{' '}
              {ANNOTATION_FLOOR}.
            </p>
            <BackToSets org={search.org} />
          </Stage>
        </AnnotateFrame>
      )
    }

    if (data.state === 'drained') {
      return (
        <AnnotateFrame>
          <Stage title="All caught up">
            <p className="m-0 text-muted-foreground">
              {data.annotated} annotated in this set. Nothing left to answer here.
            </p>
            <div className="flex flex-wrap justify-center gap-[var(--gap-inline)]">
              {data.annotated > 0 ? (
                <Button type="button" variant="outline" onClick={() => void stepBack()}>
                  Back to the last one
                </Button>
              ) : null}
              <Button asChild>
                <Link to="/annotate" search={{ org: search.org }}>
                  Your sets
                </Link>
              </Button>
            </div>
          </Stage>
        </AnnotateFrame>
      )
    }
  }

  if (shownItem === null) return null

  const remaining = shownItem.remaining
  const overCap = note.length > ANNOTATION_NOTE_MAX_LENGTH

  return (
    <AnnotateFrame>
      <main className="mx-auto max-w-[46rem] px-[var(--space-6)] pt-[var(--space-8)] pb-[var(--space-16)]">
        <div className="mb-[var(--space-8)] flex flex-wrap items-baseline justify-between gap-[var(--gap-inline)]">
          <span className="flex items-baseline gap-[var(--gap-inline)]">
            <Link
              to="/annotate"
              search={{ org: search.org }}
              className="text-data text-muted-foreground hover:text-foreground"
            >
              ← Your sets
            </Link>
            <b className="font-semibold">{setName}</b>
          </span>
          {/*
            ANNOTATED, ever — counted by the server from the rows themselves, not by this page.
            It was a `useState` that reset on every navigation, so leaving and coming back read
            as the work having been lost.
          */}
          <span className="flex items-baseline gap-[var(--gap-inline)]">
            {/*
              ONE STEP BACK, and only when there is one. A full history was declined with r6
              (decision 11): a list of past answers invites second-guessing, where a mis-key
              needs exactly one door.
            */}
            {undo === null && shownItem.annotated > 0 ? (
              <button
                type="button"
                onClick={() => void stepBack()}
                className="text-data text-muted-foreground hover:text-foreground"
              >
                ← Back to the last one
              </button>
            ) : null}
            {undo === null ? null : (
              <button
                type="button"
                onClick={() => setUndo(null)}
                className="text-data text-muted-foreground hover:text-foreground"
              >
                Back to the queue
              </button>
            )}
            <span className="font-mono text-data text-muted-foreground tabular-nums">
              {shownItem.annotated} annotated · {remaining} left
            </span>
          </span>
        </div>

        <article className="rounded-[var(--radius-panel)] border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)] shadow-[var(--shadow-raise)]">
          <h1 className="m-0 mb-[var(--space-2)] text-title leading-[var(--leading-title)] font-semibold tracking-[var(--tracking-snug)]">
            Is this output acceptable?
          </h1>
          {/* Generic on purpose (r6 decision 4): it must stay true when M6 adds samplers. */}
          <p className="m-0 mb-[var(--space-6)] text-data text-muted-foreground">
            One of the traces in this set.
          </p>

          {undo === null ? null : (
            // Your OWN last answer, not a machine's opinion: ADR-0067 withholds what a judge
            // or the platform thinks, which is not the same as what you said a moment ago.
            <p className="m-0 mb-[var(--space-5)] rounded-[var(--radius-field)] border bg-muted px-[var(--pad-field-x)] py-[var(--pad-field-y)] text-data text-muted-foreground">
              You answered <b className="text-foreground">{OUTCOME_WORDS[undo.previous_outcome]}</b>
              . Answering again records a new answer; the first one stays.
            </p>
          )}

          <ShapedTrace
            input={shownItem.input}
            output={shownItem.output}
            reference={shownItem.reference}
            metadata={null}
          />

          <fieldset className="mt-[var(--space-8)] flex flex-wrap items-center gap-[var(--gap-inline)] border-0 p-0">
            <legend className="sr-only">Your answer</legend>
            <Choice
              label="Acceptable"
              hint="Y"
              selected={answer === 'acceptable'}
              onClick={() => choose('acceptable')}
            />
            <Choice
              label="Not acceptable"
              hint="N"
              selected={answer === 'not_acceptable'}
              onClick={() => choose('not_acceptable')}
            />
            <button
              type="button"
              onClick={() => choose('skipped')}
              aria-pressed={answer === 'skipped'}
              className={cn(
                'ml-auto rounded-[var(--radius-control)] border border-transparent px-[var(--pad-control-x)] py-[var(--pad-control-y)] text-ui text-muted-foreground hover:bg-muted hover:text-foreground',
                answer === 'skipped' && 'border-border bg-muted text-foreground',
              )}
            >
              Skip <Hint>S</Hint>
            </button>
          </fieldset>

          {noteRequired(answer) ? (
            <div className="mt-[var(--space-6)] border-t pt-[var(--space-6)]">
              <label htmlFor="note" className="mb-[var(--space-1)] block font-semibold">
                What’s wrong with it?
              </label>
              <span className="mb-[var(--space-3)] block text-data text-muted-foreground">
                Required. One or two sentences.
              </span>
              <textarea
                id="note"
                ref={noteRef}
                rows={3}
                maxLength={ANNOTATION_NOTE_MAX_LENGTH}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Refused a same-day refund the policy allows; never mentions the 14-day window."
                className="box-border w-full resize-y rounded-[var(--radius-field)] border bg-background px-[var(--pad-field-x)] py-[var(--pad-field-y)] text-body leading-[var(--leading-body)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <span
                className={cn(
                  'mt-[var(--space-2)] block text-right font-mono text-micro tabular-nums text-muted-foreground',
                  (note.length >= ANNOTATION_NOTE_MAX_LENGTH - 30 || overCap) && 'text-warning',
                )}
              >
                {note.length} / {ANNOTATION_NOTE_MAX_LENGTH}
              </span>
            </div>
          ) : null}

          <div className="mt-[var(--space-6)] flex flex-wrap items-center justify-between gap-[var(--gap-inline)] border-t pt-[var(--space-5)]">
            <span className="text-data text-muted-foreground">
              {save.error === null ? 'Skipping is always fine.' : 'That didn’t save. Try again.'}
            </span>
            <Button
              type="button"
              onClick={submit}
              disabled={!canSave(answer, note) || save.isPending}
            >
              {save.isPending ? 'Saving…' : 'Save and next'} <Hint>↵</Hint>
            </Button>
          </div>
        </article>
      </main>
    </AnnotateFrame>
  )
}

/**
 * The two answers carry EQUAL WEIGHT until one is chosen (r6 decision 2). Neither is styled as
 * the primary action, and a button fills only when selected: a dominant "Acceptable" would
 * manufacture the agreement M6 exists to measure.
 */
const Choice = ({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string
  hint: string
  selected: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={selected}
    className={cn(
      'rounded-[var(--radius-control)] border px-[var(--pad-control-x)] py-[var(--pad-control-y)] text-ui font-semibold',
      selected
        ? 'border-primary bg-primary text-primary-foreground'
        : 'border-border bg-transparent text-foreground hover:bg-muted',
    )}
  >
    {label} <Hint>{hint}</Hint>
  </button>
)

const Hint = ({ children }: { children: React.ReactNode }) => (
  <kbd className="rounded-[var(--radius-xs)] border border-current px-[var(--space-1)] font-mono text-micro opacity-70">
    {children}
  </kbd>
)

const BackToSets = ({ org }: { org?: string | undefined }) => (
  <div>
    <Button asChild variant="outline">
      <Link to="/annotate" search={{ org }}>
        Your sets
      </Link>
    </Button>
  </div>
)
