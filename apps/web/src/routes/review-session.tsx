import { ANNOTATION_NOTE_MAX_LENGTH } from '@labelloop/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { cn } from 'cn'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.ts'
import { reviewNextQuery } from '../api/queries.ts'
import {
  type Answer,
  answerBody,
  canSave,
  keyToAction,
  noteRequired,
} from '../components/review/answer-state.ts'
import { ReviewFrame, Stage } from '../components/review/review-frame.tsx'
import { ShapedTrace } from '../components/shaped/shaped-trace.tsx'
import type { ConsoleSearch } from '../components/shell/context.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { Button } from '../components/ui/button.tsx'
import { apiErrorFrom } from '../errors/api-error.ts'

/**
 * `/review/$panelSlug` — ONE TRACE, ONE QUESTION (r6, ADR-0066).
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
export const ReviewSessionPage = () => {
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const { panelSlug } = useParams({ strict: false }) as { panelSlug: string }
  const orgId = context.state === 'ready' ? context.orgId : ''

  /** Advancing the queue is an explicit step, not a refetch — see `reviewNextQuery`. */
  const [nonce, setNonce] = useState(0)
  const [answer, setAnswer] = useState<Answer>(null)
  const [note, setNote] = useState('')
  /** Answered in THIS session, which is the only progress a person needs (r6 decision 11). */
  const [done, setDone] = useState(0)
  const noteRef = useRef<HTMLTextAreaElement>(null)

  const item = useQuery({
    ...reviewNextQuery(orgId, panelSlug, nonce),
    enabled: context.state === 'ready',
  })

  const data = item.data
  const itemId = data?.state === 'item' ? data.item_id : undefined

  const save = useMutation({
    mutationFn: async (body: ReturnType<typeof answerBody>) => {
      const response = await api.internal.review.annotations.$post(
        { json: body },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: () => {
      setDone((count) => count + 1)
      setAnswer(null)
      setNote('')
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
      <ReviewFrame>
        <Stage title="Loading…" />
      </ReviewFrame>
    )
  }

  if (item.error !== null || data === undefined) {
    return (
      <ReviewFrame>
        <Stage title="This couldn’t be loaded">
          <p className="m-0 text-muted-foreground">Nothing has been recorded. Try again shortly.</p>
          <BackToPanels org={search.org} />
        </Stage>
      </ReviewFrame>
    )
  }

  if (data.state === 'locked') {
    return (
      <ReviewFrame>
        <Stage title="Almost ready">
          <p className="m-0 text-muted-foreground">
            This panel has collected {data.trace_count} traces. Reviewing opens at 50.
          </p>
          <BackToPanels org={search.org} />
        </Stage>
      </ReviewFrame>
    )
  }

  if (data.state === 'drained') {
    return (
      <ReviewFrame>
        <Stage title="All caught up">
          <p className="m-0 text-muted-foreground">
            {done === 0
              ? 'Nothing left to review here. New traces appear as the panel collects them.'
              : `${done} reviewed. New traces appear here as the panel collects them.`}
          </p>
          <BackToPanels org={search.org} />
        </Stage>
      </ReviewFrame>
    )
  }

  const remaining = data.remaining
  const overCap = note.length > ANNOTATION_NOTE_MAX_LENGTH

  return (
    <ReviewFrame>
      <main className="mx-auto max-w-[46rem] px-[var(--space-6)] pt-[var(--space-8)] pb-[var(--space-16)]">
        <div className="mb-[var(--space-8)] flex flex-wrap items-baseline justify-between gap-[var(--gap-inline)]">
          <span className="flex items-baseline gap-[var(--gap-inline)]">
            <Link
              to="/review"
              search={{ org: search.org }}
              className="text-data text-muted-foreground hover:text-foreground"
            >
              ← All panels
            </Link>
            <b className="font-semibold">{panelSlug}</b>
          </span>
          <span className="font-mono text-data text-muted-foreground tabular-nums">
            {done} this session · {remaining} left
          </span>
        </div>

        <article className="rounded-[var(--radius-panel)] border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)] shadow-[var(--shadow-raise)]">
          <h1 className="m-0 mb-[var(--space-2)] text-title leading-[var(--leading-title)] font-semibold tracking-[var(--tracking-snug)]">
            Is this output acceptable?
          </h1>
          {/* Generic on purpose (r6 decision 4): it must stay true when M6 adds samplers. */}
          <p className="m-0 mb-[var(--space-6)] text-data text-muted-foreground">
            One of the traces this panel collected.
          </p>

          <ShapedTrace
            input={data.input}
            output={data.output}
            reference={data.reference}
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
    </ReviewFrame>
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

const BackToPanels = ({ org }: { org?: string | undefined }) => (
  <div>
    <Button asChild variant="outline">
      <Link to="/review" search={{ org }}>
        All panels
      </Link>
    </Button>
  </div>
)
