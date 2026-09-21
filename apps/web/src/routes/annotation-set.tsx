import { can } from '@labelloop/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { cn } from 'cn'
import { Settings2Icon, UserIcon } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../api/client.ts'
import { annotationSetQuery, membersQuery } from '../api/queries.ts'
import {
  type ConsoleSearch,
  useConsoleContext,
  usePanelContext,
} from '../components/shell/context.ts'
import { Data, Eyebrow, Mark } from '../components/shell/mark.tsx'
import { BACK_LINK, PageHead, panelTrail } from '../components/shell/page-head.tsx'
import { LoadFailed } from '../components/shell/statement.tsx'
import { Button } from '../components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.tsx'
import { apiErrorFrom } from '../errors/api-error.ts'

/**
 * ONE ANNOTATION SET — who is assigned, where each of them is, and what each of them selected
 * on every trace (ADR-0084).
 *
 * **NOTHING ON THIS SCREEN OFFERS TO CHANGE AN ANSWER**, and it is absent rather than disabled.
 * A developer can create a set, pick its traces, name it, assign annotators, name the dictator,
 * top it up, archive it, and read everything anybody answered. They cannot change, delete,
 * re-answer or override a single annotation: an engineer able to correct one would destroy the
 * disagreement M6 exists to measure. Where an answer looks wrong the remedy is another
 * annotator on the set (ADR-0081), not an edit.
 *
 * **The grid is the point.** One row per trace, one column per annotator, so disagreement is
 * visible by scanning down a column rather than by opening anything. Where answers differ, the
 * one that COUNTS is marked — the dictator's, by ADR-0081's read rule, computed on the server
 * so this screen and M6 cannot disagree about it.
 *
 * Clicking a trace row opens the drawer M5 phase 6 built, which already renders the annotations
 * block read-only with each person's note. One rendering of a trace's answers, reused.
 */
export const AnnotationSetPage = () => {
  const queryClient = useQueryClient()
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  const { setId } = useParams({ strict: false }) as { setId: string }

  const orgId = context.state === 'ready' ? context.orgId : ''
  const set = useQuery({
    ...annotationSetQuery(orgId, setId),
    enabled: context.state === 'ready',
  })

  const [assigning, setAssigning] = useState(false)
  const [archiving, setArchiving] = useState(false)

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['annotation-set', orgId, setId] }),
      queryClient.invalidateQueries({ queryKey: ['annotation-sets', orgId] }),
    ])

  const topUp = useMutation({
    mutationFn: async () => {
      const response = await api.internal['annotation-sets'][':id']['top-up'].$post(
        { param: { id: setId }, json: { strategy: 'random_n', size: 25 } },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async (data) => {
      await refresh()
      toast.success(
        data.added === 0
          ? 'Nothing left to add — this set already holds every trace the panel has.'
          : `Added ${data.added}. The set now holds ${data.size}.`,
      )
    },
    onError: () => toast.error('That couldn’t be topped up. Nothing was changed.'),
  })

  const archive = useMutation({
    mutationFn: async () => {
      const response = await api.internal['annotation-sets'][':id'].archive.$post(
        { param: { id: setId } },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async () => {
      setArchiving(false)
      await refresh()
      toast.success('Archived. It is still readable behind the filter.')
    },
    onError: () => toast.error('That couldn’t be archived. Nothing was changed.'),
  })

  if (context.state !== 'ready' || panel.state !== 'ready') return null

  const curates = can(context.role, { annotation: ['curate'] })
  const back = (
    <Link
      to="/p/$panelSlug/annotations"
      params={{ panelSlug: panel.slug }}
      search={{ org: context.orgSlug }}
      className={BACK_LINK}
    >
      ← Annotations
    </Link>
  )

  if (set.isPending) {
    return (
      <>
        <PageHead
          scope={panelTrail(context.orgSlug, panel.slug)}
          title="Annotation set"
          back={back}
        />
        <p className="text-muted-foreground">Loading…</p>
      </>
    )
  }

  if (set.error !== null) {
    return (
      <>
        <PageHead
          scope={panelTrail(context.orgSlug, panel.slug)}
          title="Annotation set"
          back={back}
        />
        <LoadFailed what="This set" error={set.error} onReload={() => void refresh()} />
      </>
    )
  }

  const data = set.data
  const archived = data.archived_at !== null
  const live = data.annotators.filter((annotator) => annotator.unassigned_at === null)
  /**
   * The COLUMN ORDER of the grid, and it includes people who have been unassigned: their
   * answers stay and stay visible (ADR-0086). A column that vanished when somebody was taken
   * off the set would be the console deciding their work did not happen.
   */
  const columns = data.annotators

  /**
   * A DEVELOPER WHO IS ASSIGNED sees the one route from this console to the annotator surface,
   * and only here (ADR-0084, open question 5). It is their own work, on their own set, chosen
   * deliberately — the opposite of the ambush phase 5 shipped. It must never appear on a set
   * they are not assigned to, which is exactly what this condition says.
   */
  const assignedToMe = live.some((annotator) => annotator.email === context.email)

  return (
    <>
      <PageHead
        scope={panelTrail(context.orgSlug, panel.slug)}
        title={data.name}
        back={back}
        meta={
          <span className="flex flex-wrap items-center gap-[var(--gap-inline)]">
            <Data>
              {data.size} {data.size === 1 ? 'trace' : 'traces'}
            </Data>
            {archived ? (
              <Mark tone="neutral" title={`Archived ${data.archived_at?.slice(0, 10)}`}>
                archived
              </Mark>
            ) : data.done ? (
              <Mark
                tone="neutral"
                title="Every currently assigned annotator has answered every trace"
              >
                done
              </Mark>
            ) : (
              <Mark tone="neutral">active</Mark>
            )}
          </span>
        }
        actions={
          <span className="flex flex-wrap items-center gap-[var(--gap-inline)]">
            {assignedToMe ? (
              // A real link out of the console, on their OWN assigned set. The only one.
              <Button asChild variant="outline">
                <Link to="/annotate/$setId" params={{ setId }} search={{ org: context.orgSlug }}>
                  Annotate your copy
                </Link>
              </Button>
            ) : null}
            {curates && !archived ? (
              <>
                <Button variant="outline" onClick={() => setAssigning(true)}>
                  Assign annotators
                </Button>
                <Button variant="outline" onClick={() => topUp.mutate()} disabled={topUp.isPending}>
                  {topUp.isPending ? 'Adding…' : 'Top up 25'}
                </Button>
                <Button variant="outline" onClick={() => setArchiving(true)}>
                  Archive
                </Button>
              </>
            ) : null}
          </span>
        }
      />

      <section className="flex flex-col gap-[var(--gap-stack)]">
        <Eyebrow>Assigned</Eyebrow>
        {columns.length === 0 ? (
          <p className="m-0 text-muted-foreground">
            Nobody is assigned yet, so nobody has anything to annotate. Assignment is what makes the
            work exist.
          </p>
        ) : (
          // A GRID rather than a stack of full-width rows. Four people are four people, not four
          // table rows — and at console width a row 1400px wide holding a name and a number is
          // mostly empty space with the two facts at opposite ends of it. `auto-fill` at 15rem
          // gives four across on a wide screen and one on a narrow one without a breakpoint.
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-[var(--gap-tight)] p-0">
            {columns.map((annotator) => (
              <AnnotatorCard
                key={annotator.user_id}
                annotator={annotator}
                size={data.size}
                {...(curates && !archived ? { onManage: () => setAssigning(true) } : {})}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-[var(--gap-stack)]">
        <Eyebrow>Answers · {data.size}</Eyebrow>
        {data.size === 0 ? (
          <p className="m-0 text-muted-foreground">This set holds no traces.</p>
        ) : (
          <AnswerGrid traces={data.traces} columns={columns} search={search} />
        )}
      </section>

      <AssignDialog
        open={assigning}
        onClose={() => setAssigning(false)}
        orgId={orgId}
        setId={setId}
        assigned={data.annotators}
        onDone={refresh}
      />

      <Dialog open={archiving} onOpenChange={(open) => !open && setArchiving(false)}>
        <DialogContent>
          <DialogHeader>
            <Eyebrow>Archive set</Eyebrow>
            <DialogTitle>Archive “{data.name}”?</DialogTitle>
            <DialogDescription>
              It leaves the default list and stops appearing as work for its annotators. Every
              answer stays, and the set is still readable behind the archived filter. Archiving says
              nothing about whether it was finished.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiving(false)}>
              Cancel
            </Button>
            <Button onClick={() => archive.mutate()} disabled={archive.isPending}>
              {archive.isPending ? 'Archiving…' : 'Archive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

type Detail = Awaited<ReturnType<NonNullable<ReturnType<typeof annotationSetQuery>['queryFn']>>>
type Annotator = Detail['annotators'][number]
type SetTrace = Detail['traces'][number]

/**
 * ONE PERSON, AS A CARD: who they are, how far they have got, and whether they settle a
 * disagreement.
 *
 * **A card rather than a row, because these are people.** The rest of this screen is tables —
 * traces, answers, ids — and the Assigned block was one too, which at console width meant a
 * name at the far left and a number at the far right with a thousand pixels of nothing between
 * them. A person is not a row of a table of traces.
 *
 * It stays the CONSOLE though: no fill, no shadow, no colour that is not carrying a fact. The
 * card is defined by its border and its internal space, which is the same restraint every other
 * surface here follows — on a dark surface, space reads and fills shout.
 *
 * `answered` rather than `annotated` — it includes skips, because a skip empties that trace out
 * of their queue. It is the same number `setProgress` decides "done" from, so a card reading
 * "12 of 12" beside a set not marked done would be a contradiction this screen cannot produce.
 * The skip-excluding count is on the tooltip, where the person wondering about it will look.
 */
const AnnotatorCard = ({
  annotator,
  size,
  onManage,
}: {
  annotator: Annotator
  size: number
  /**
   * Absent for anybody who cannot curate, and on an archived set. It opens the assign dialog —
   * the one place assignment actually changes — rather than being a per-card menu of its own:
   * assignment is declared as a whole list (the server's `PUT` treats it that way), so a
   * control that edited one person would be lying about what it does.
   *
   * **It changes who is ASSIGNED. It can never change what anybody ANSWERED** (ADR-0084).
   */
  onManage?: () => void
}) => {
  const pct = size === 0 ? 0 : Math.min(100, Math.round((annotator.answered / size) * 100))
  const gone = annotator.unassigned_at !== null
  const who = annotator.name === '' ? annotator.email : annotator.name

  return (
    <li
      className={cn(
        'group relative flex flex-col gap-[var(--gap-inline)]',
        'rounded-md border border-border-soft px-[var(--pad-field-x)] py-[var(--pad-field-y)]',
        // Unassigned is still listed and still readable — their answers stay (ADR-0086) — but
        // it is not live work, and the card says so before the mark does.
        gone && 'opacity-70',
      )}
    >
      <div className="flex min-w-0 items-center gap-[var(--gap-inline)]">
        <Monogram who={who} muted={gone} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-ui" title={annotator.email}>
            {who}
          </span>
          {/* The address under the name, because a display name is not an identity — two
              people called Sam are told apart here and nowhere else on the card. */}
          <span className="truncate font-mono text-micro text-muted-foreground" aria-hidden>
            {annotator.email}
          </span>
        </span>
        {onManage === undefined ? null : (
          /*
            REVEALED ON HOVER *OR* FOCUS, never hover alone: a control that only exists for a
            mouse does not exist for a keyboard. `opacity-0` keeps it in the tab order and in
            the accessibility tree the whole time; `group-focus-within` is what makes tabbing
            to it visible rather than a cursor jumping to something invisible.
          */
          <button
            type="button"
            onClick={onManage}
            aria-label={`Change who is assigned (${annotator.email})`}
            title="Change who is assigned"
            className={cn(
              'ml-auto shrink-0 rounded-[var(--radius-control)] p-[var(--space-1)]',
              'text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground',
              'group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <Settings2Icon aria-hidden className="size-4" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
        {annotator.is_dictator && !gone ? (
          <Mark tone="info" title="Where answers differ, theirs is the one that counts">
            dictator
          </Mark>
        ) : null}
        {gone ? (
          <Mark
            tone="neutral"
            title={`Unassigned ${annotator.unassigned_at?.slice(0, 10)} — their answers stay`}
          >
            unassigned
          </Mark>
        ) : null}
        <Data
          className="ml-auto tabular-nums"
          title={`${annotator.annotated} annotated, skips excluded`}
        >
          {annotator.answered} of {size}
        </Data>
      </div>

      {/*
        `mt-auto` PINS THE BAR TO THE BOTTOM, and that is what keeps a row of cards aligned.
        The line above holds a `Mark` on some cards and only a number on others, and a mark is
        two pixels taller than bare text — so bars laid out in flow sat two pixels apart from
        card to card, which across four of them reads as ragged rather than as a difference
        that means something. The grid already makes the cards equal height; this makes the bar
        the line they are measured from, with no arithmetic to get wrong.
      */}
      <span
        className="mt-auto h-[var(--space-1)] overflow-hidden rounded-[var(--radius-pill)] bg-muted"
        role="progressbar"
        aria-valuenow={annotator.answered}
        aria-valuemin={0}
        aria-valuemax={size}
        aria-label={`${annotator.email}: ${annotator.answered} of ${size} answered`}
      >
        {/* Achromatic: progress is not a finding (tokens.css rule 4). */}
        <span className="block h-full bg-muted-foreground" style={{ width: `${pct}%` }} />
      </span>
    </li>
  )
}

/**
 * INITIALS, not an avatar service and not a generic silhouette for everybody.
 *
 * Two letters from a name are enough to tell four people apart at a glance, which is the whole
 * job here, and they need no network request and no gravatar-shaped privacy question. It stays
 * achromatic — a per-person colour would be decoration, and the one fact on this card that
 * earns colour is already carrying it (the dictator mark). `UserIcon` is the fallback for an
 * account with nothing to take an initial from.
 */
const Monogram = ({ who, muted }: { who: string; muted: boolean }) => {
  const initials = who
    .split(/[\s@._-]+/)
    .filter((part) => /\p{L}|\p{N}/u.test(part))
    .slice(0, 2)
    .map((part) => [...part][0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span
      aria-hidden
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-full border border-border-soft',
        'bg-muted font-mono text-micro tracking-[var(--tracking-wide)]',
        muted ? 'text-foreground-faint' : 'text-muted-foreground',
      )}
    >
      {initials === '' ? <UserIcon className="size-4" /> : initials}
    </span>
  )
}

/**
 * THE TRACE × ANNOTATOR GRID. One row per trace, one column per person, so disagreement is
 * visible by scanning down a column rather than by opening anything.
 *
 * An UNANSWERED cell says so rather than being blank: blank is indistinguishable from a column
 * that failed to load, and "nobody has got to this one" is a fact a developer watching progress
 * actually wants.
 */
const AnswerGrid = ({
  traces,
  columns,
  search,
}: {
  traces: readonly SetTrace[]
  columns: readonly Annotator[]
  search: ConsoleSearch
}) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-data">
      <thead>
        <tr className="border-b border-border-strong text-left">
          <th className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground">
            Trace
          </th>
          {columns.map((annotator) => (
            <th
              key={annotator.user_id}
              title={annotator.email}
              className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
            >
              {annotator.name === '' ? annotator.email : annotator.name}
              {annotator.is_dictator && annotator.unassigned_at === null ? ' ·' : ''}
            </th>
          ))}
          <th
            title="Where answers differ, the dictator’s is the one that counts (ADR-0081). Blank while there is no tie-break."
            className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
          >
            Counts
          </th>
        </tr>
      </thead>
      <tbody>
        {traces.map((trace) => {
          const differ = new Set(trace.answers.map((answer) => answer.outcome)).size > 1
          return (
            <tr
              key={trace.trace_id}
              className={cn(
                'relative border-b border-border-soft hover:bg-muted',
                search.trace === trace.trace_id && 'bg-muted',
              )}
            >
              <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle whitespace-nowrap">
                {/*
                  Opens the drawer M5 phase 6 built — which already renders the annotations
                  block, read-only, one entry per person with their note. One rendering of a
                  trace's answers, reused; not a second one.
                */}
                <Link
                  // The row's own address is unchanged — only `?trace=` moves — so this is a
                  // link to THIS page with the drawer open, exactly as the trace table's is.
                  to="."
                  search={{ ...search, trace: trace.trace_id }}
                  className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
                >
                  <Data className="text-foreground">{trace.trace_id}</Data>
                </Link>
              </td>
              {columns.map((annotator) => {
                const answer = trace.answers.find(
                  (candidate) => candidate.annotator_id === annotator.user_id,
                )
                return (
                  <td
                    key={annotator.user_id}
                    className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle whitespace-nowrap"
                  >
                    {answer === undefined ? (
                      <Data className="text-foreground-faint">—</Data>
                    ) : (
                      <span className="flex items-center gap-[var(--gap-tight)]">
                        <Outcome outcome={answer.outcome} />
                        {answer.note === null ? null : <Data title={answer.note}>note</Data>}
                        {answer.revisions === 0 ? null : (
                          <Data title={`${answer.revisions + 1} answers, the earlier ones kept`}>
                            changed
                          </Data>
                        )}
                      </span>
                    )}
                  </td>
                )
              })}
              <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle whitespace-nowrap">
                {trace.counting === null ? (
                  <Data className="text-foreground-faint">—</Data>
                ) : (
                  <span className="flex items-center gap-[var(--gap-tight)]">
                    <Outcome outcome={trace.counting.outcome} />
                    {/* Only worth saying when there was something to settle. */}
                    {differ ? (
                      <Data title="They disagreed; the dictator’s counts">by dictator</Data>
                    ) : null}
                  </span>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  </div>
)

/**
 * The three outcomes in the words the annotator was shown (ADR-0066) — the same rendering the
 * trace drawer uses. A SKIP is not a failure and not a pass: it says something about the
 * pairing of person and trace, not about the output.
 */
const Outcome = ({ outcome }: { outcome: string }) =>
  outcome === 'skipped' ? (
    <Mark tone="neutral">skipped</Mark>
  ) : (
    <Mark tone={outcome === 'acceptable' ? 'success' : 'fail'}>
      {outcome === 'acceptable' ? 'acceptable' : 'not acceptable'}
    </Mark>
  )

/**
 * ASSIGN ANNOTATORS — the whole list, declared at once, because the server's `PUT` treats it
 * that way: anyone assigned and not named here is unassigned by the call, which stamps their
 * row and keeps their answers (ADR-0086).
 *
 * **It draws from the org's MEMBERS, not from its annotators** (open question 5). A developer
 * may be assigned a set and annotate it like anybody else; what ADR-0084 forbids is arriving
 * without having chosen to.
 *
 * The dictator radio is REQUIRED once two people are ticked, because the server refuses
 * anything else — one rule in both directions, so no ordering of calls reaches a set with a
 * disagreement and nobody to settle it.
 */
const AssignDialog = ({
  open,
  onClose,
  orgId,
  setId,
  assigned,
  onDone,
}: {
  open: boolean
  onClose: () => void
  orgId: string
  setId: string
  assigned: readonly Annotator[]
  onDone: () => Promise<unknown>
}) => {
  const members = useQuery({ ...membersQuery(orgId), enabled: open })
  const live = assigned.filter((annotator) => annotator.unassigned_at === null)
  const [picked, setPicked] = useState<string[] | null>(null)
  const [dictator, setDictator] = useState<string | null>(null)

  // Seeded from what the set holds the first time the dialog is opened, so the list starts as
  // the truth rather than as empty — this is an edit of an assignment, not a fresh one.
  const chosen = picked ?? live.map((annotator) => annotator.user_id)
  const chosenDictator =
    dictator ?? live.find((annotator) => annotator.is_dictator)?.user_id ?? null

  const save = useMutation({
    mutationFn: async () => {
      const response = await api.internal['annotation-sets'][':id'].annotators.$put(
        {
          param: { id: setId },
          json: {
            annotators: chosen.map((userId) => ({
              user_id: userId,
              is_dictator: userId === chosenDictator,
            })),
          },
        },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async (data) => {
      await onDone()
      close()
      toast.success(
        data.unassigned === 0
          ? `${data.assigned} assigned.`
          : `${data.assigned} assigned, ${data.unassigned} unassigned. Their answers stay.`,
      )
    },
    onError: () => toast.error('That couldn’t be saved. Nothing was changed.'),
  })

  const close = () => {
    setPicked(null)
    setDictator(null)
    save.reset()
    onClose()
  }

  const needsDictator =
    chosen.length >= 2 && (chosenDictator === null || !chosen.includes(chosenDictator))

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-[34rem]">
        <DialogHeader>
          <Eyebrow>Annotation set</Eyebrow>
          <DialogTitle>Assign annotators</DialogTitle>
          <DialogDescription>
            Everyone assigned annotates the whole set. Taking somebody off keeps their answers — the
            work happened.
          </DialogDescription>
        </DialogHeader>

        {members.isPending ? (
          <p className="m-0 text-muted-foreground">Loading members…</p>
        ) : members.error !== null ? (
          <p className="m-0 text-fail">Members couldn’t be loaded. Nothing has been changed.</p>
        ) : (
          <ul className="m-0 flex max-h-[18rem] list-none flex-col gap-[var(--gap-tight)] overflow-y-auto p-0">
            {members.data.members.map((member) => {
              const ticked = chosen.includes(member.user_id)
              return (
                <li
                  key={member.user_id}
                  className="flex items-center gap-[var(--gap-inline)] rounded-md px-[var(--pad-field-x)] py-[var(--pad-field-y)] hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    id={`assign-${member.user_id}`}
                    checked={ticked}
                    onChange={(event) =>
                      setPicked(
                        event.target.checked
                          ? [...chosen, member.user_id]
                          : chosen.filter((id) => id !== member.user_id),
                      )
                    }
                  />
                  <label htmlFor={`assign-${member.user_id}`} className="min-w-0 flex-1 text-ui">
                    <span className="truncate">{member.email}</span>
                    <Mark tone="neutral" className="ml-[var(--gap-inline)]">
                      {member.role.replace('_', ' ')}
                    </Mark>
                  </label>
                  {/*
                    THE DICTATOR, as a radio inside the list rather than as a second control
                    below it: it is a property of one of these people, and asking for it
                    somewhere else would make the reader hold two lists in their head.
                  */}
                  <label
                    className={cn(
                      'flex items-center gap-[var(--gap-tight)] text-ui text-muted-foreground',
                      !ticked && 'invisible',
                    )}
                  >
                    <input
                      type="radio"
                      name="dictator"
                      checked={chosenDictator === member.user_id}
                      onChange={() => setDictator(member.user_id)}
                    />
                    dictator
                  </label>
                </li>
              )
            })}
          </ul>
        )}

        {needsDictator ? (
          <p className="m-0 text-ui text-warning">
            Two or more annotators need a dictator — the one whose answer counts where they differ.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} disabled={needsDictator || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
