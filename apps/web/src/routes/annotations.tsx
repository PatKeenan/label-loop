import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import { annotationSetsQuery } from '../api/queries.ts'
import { CreateAnnotationSetDialog } from '../components/shell/annotation-set-dialog.tsx'
import {
  type ConsoleSearch,
  useConsoleContext,
  usePanelContext,
} from '../components/shell/context.ts'
import { Data, Mark } from '../components/shell/mark.tsx'
import { PageHead, panelTrail } from '../components/shell/page-head.tsx'
import { LoadFailed } from '../components/shell/statement.tsx'
import { Button } from '../components/ui/button.tsx'

/**
 * THE ANNOTATIONS SECTION — a panel's annotation sets, and how far each has got (ADR-0084).
 *
 * **It is the engineer console throughout** (PRODUCT 5.5): dark, dense, inside `ConsoleShell`,
 * with the same `PageHead`, `panelTrail`, table and `Mark`/`Data` idioms as Traces and Keys. No
 * annotator component appears here, and no console component appears there — `architecture.test.ts`
 * asserts it rather than this paragraph doing so.
 *
 * **Staff read; they do not answer.** There is no control on this section that changes an
 * annotation, because nobody annotates somebody else's work: an engineer able to correct one
 * would destroy the disagreement M6 exists to measure (ADR-0084). Where an answer looks wrong,
 * the remedy is another annotator on the set (ADR-0081).
 */

/**
 * THREE STATES, and only one of them is stored (ADR-0086).
 *
 * `done` is DERIVED by the server — every currently assigned annotator has answered every
 * trace — and arrives with the row rather than being recomputed here: two screens computing it
 * separately would disagree, and the one that disagreed would be believed. `archived` is the
 * one stamp a person writes.
 *
 * Archived WINS over done, because "put away" is what a reader needs to know first; a set can
 * be both, and an abandoned half-finished pass is archived and not done.
 */
type SetRow = Awaited<
  ReturnType<NonNullable<ReturnType<typeof annotationSetsQuery>['queryFn']>>
>[number]

export const AnnotationsPage = () => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const context = useConsoleContext()
  const search = useSearch({ strict: false }) as ConsoleSearch
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)

  const orgId = context.state === 'ready' ? context.orgId : ''
  const panelSlug = panel.state === 'ready' ? panel.slug : ''
  const sets = useQuery({
    ...annotationSetsQuery(orgId, panelSlug),
    enabled: context.state === 'ready' && panel.state === 'ready',
  })

  if (context.state !== 'ready' || panel.state !== 'ready') return null

  const showArchived = search.archived === true
  const openDialog = () =>
    void navigate({ to: '.', search: { ...search, newSet: true }, replace: false })
  const closeDialog = () => void navigate({ to: '.', search: { ...search, newSet: undefined } })

  const head = (
    <PageHead
      scope={panelTrail(context.orgSlug, panel.slug)}
      title="Annotations"
      actions={<Button onClick={openDialog}>New annotation set</Button>}
    />
  )

  if (sets.isPending) {
    return (
      <>
        {head}
        <p className="text-muted-foreground">Loading…</p>
      </>
    )
  }

  if (sets.error !== null) {
    return (
      <>
        {head}
        <LoadFailed
          what="Annotation sets"
          error={sets.error}
          onReload={() =>
            void queryClient.invalidateQueries({ queryKey: ['annotation-sets', orgId, panelSlug] })
          }
        />
      </>
    )
  }

  const all = sets.data
  const archivedCount = all.filter((set) => set.archived_at !== null).length
  const rows = showArchived ? all : all.filter((set) => set.archived_at === null)

  return (
    <>
      {head}
      {all.length === 0 ? (
        <p className="text-muted-foreground">
          No annotation sets for {panel.name} yet. A set is a named, snapshotted selection of this
          panel’s traces, assigned to the people who will answer them — until one exists, nobody has
          anything to annotate.
        </p>
      ) : (
        <div className="flex flex-col gap-[var(--gap-stack)]">
          <SetTable rows={rows} panelSlug={panel.slug} orgSlug={context.orgSlug} />
          <div className="flex items-center gap-[var(--gap-inline)]">
            <Data>
              {rows.length} {rows.length === 1 ? 'set' : 'sets'} shown
            </Data>
            {/*
              THE ARCHIVED FILTER, defaulting to hiding them. An archive nobody can see is a
              delete, and an archive always on screen is not an archive — so the filter exists
              and its default is off. It is in the URL, so the view is shareable and survives a
              reload, like every other piece of view state here.
            */}
            {archivedCount === 0 ? null : (
              <Button
                size="sm"
                variant="outline"
                className="ml-auto"
                onClick={() =>
                  void navigate({
                    to: '.',
                    search: { ...search, archived: showArchived ? undefined : true },
                  })
                }
              >
                {showArchived ? 'Hide archived' : `Show archived (${archivedCount})`}
              </Button>
            )}
          </div>
        </div>
      )}

      <CreateAnnotationSetDialog
        open={search.newSet === true}
        onClose={closeDialog}
        orgId={orgId}
        orgSlug={context.orgSlug}
        panelSlug={panel.slug}
        panelTraceCount={panel.traceCount}
      />
    </>
  )
}

const COLUMNS: readonly { label: string; title?: string }[] = [
  { label: 'Set' },
  { label: 'Size', title: 'How many traces the set holds. It grows only by an explicit top-up.' },
  {
    label: 'State',
    title:
      '“done” is derived — every currently assigned annotator has answered every trace. “archived” is a stamp somebody wrote; a set can be archived without being done.',
  },
  { label: 'Created' },
]

const SetTable = ({
  rows,
  panelSlug,
  orgSlug,
}: {
  rows: readonly SetRow[]
  panelSlug: string
  orgSlug: string
}) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-data">
      <thead>
        <tr className="border-b border-border-strong text-left">
          {COLUMNS.map(({ label, title }) => (
            <th
              key={label}
              {...(title === undefined ? {} : { title })}
              className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((set) => (
          // The ROW opens the set, through a real link in its first cell stretched across the
          // row — keyboard-reachable and announced as a link, with no click handler on a `tr`.
          <tr key={set.id} className="relative border-b border-border-soft hover:bg-muted">
            <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle">
              <Link
                to="/p/$panelSlug/annotations/$setId"
                params={{ panelSlug, setId: set.id }}
                search={{ org: orgSlug }}
                className="after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                <span className="text-ui text-foreground">{set.name}</span>
              </Link>
            </td>
            <Cell>
              <Data className="tabular-nums text-foreground">{set.size}</Data>
            </Cell>
            <Cell>
              <StateMark set={set} />
            </Cell>
            <Cell>
              <Data title={`${set.created_at} · ${set.created_by_email}`}>
                {set.created_at.slice(0, 10)}
              </Data>
            </Cell>
          </tr>
        ))}
      </tbody>
    </table>
  </div>
)

/**
 * Achromatic throughout, and that is rule 4 of the approved tokens: colour appears where it IS
 * the finding. A set being done is a fact about progress, not a verdict about anything — the
 * findings on this section are what the annotators SAID, and those live inside the set.
 */
const StateMark = ({ set }: { set: SetRow }) =>
  set.archived_at !== null ? (
    <Mark tone="neutral" title={`Archived ${set.archived_at.slice(0, 10)}`}>
      archived
    </Mark>
  ) : set.done ? (
    <Mark tone="neutral" title="Every currently assigned annotator has answered every trace">
      done
    </Mark>
  ) : (
    <Mark tone="neutral">active</Mark>
  )

const Cell = ({ children }: { children: React.ReactNode }) => (
  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] align-middle whitespace-nowrap">
    {children}
  </td>
)
