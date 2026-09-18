import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { panelsQuery } from '../api/queries.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { Data, Eyebrow, Mark } from '../components/shell/mark.tsx'
import { PageHead } from '../components/shell/page-head.tsx'
import { LoadFailed } from '../components/shell/statement.tsx'
import { Button } from '../components/ui/button.tsx'

/**
 * HOME — the organisation's level, and the sign-in landing.
 *
 * **Home IS the panel list** (CONSOLE_FLOW §4), which is why there is no "Panels" nav item
 * anywhere and, since ADR-0062, no sidebar on this screen at all: at the organisation's level
 * there is exactly one thing to do, which is open a panel or make one. The sidebar appears
 * when you open one.
 *
 * At M6 this gains overview cards across panels above the list — `console-dashboard`'s
 * contents, for which Phase A stays paused (ADR-0055) — and whatever later arrives as the
 * financial view (PRODUCT.md 5.10).
 */
export const HomePage = () => {
  const context = useConsoleContext()
  const orgId = context.state === 'ready' ? context.orgId : ''
  const orgSlug = context.state === 'ready' ? context.orgSlug : ''
  const panels = useQuery({ ...panelsQuery(orgId), enabled: context.state === 'ready' })

  if (context.state !== 'ready') return null

  const head = (
    <PageHead
      scope={[orgSlug]}
      title="Panels"
      actions={
        <Button asChild>
          <Link to="/" search={{ org: orgSlug, new: true }}>
            Create panel
          </Link>
        </Button>
      }
    />
  )

  if (panels.isPending) {
    return (
      <>
        {head}
        <p className="text-muted-foreground">Loading…</p>
      </>
    )
  }
  if (panels.error !== null) {
    return (
      <>
        {head}
        <LoadFailed what="Panels" error={panels.error} onReload={() => void panels.refetch()} />
      </>
    )
  }

  // The empty state is where M4's demo starts, so it is a real screen rather than a blank page
  // with a sentence on it: it says what a panel is FOR before asking someone to make one.
  if (panels.data.length === 0) {
    return (
      <>
        {head}
        <section className="flex max-w-[var(--measure)] flex-col gap-[var(--gap-stack)] rounded-lg border border-dashed border-border-strong bg-muted px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
          <Eyebrow>No panels yet</Eyebrow>
          <h2 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">
            A panel is where your agent’s output gets judged
          </h2>
          <p className="m-0 text-body text-muted-foreground">
            You send it what your agent produced; it captures every call and, once you have judges,
            returns a decision your code can gate on. A new panel starts <strong>collecting</strong>{' '}
            — it stores traffic and judges nothing, because judges are written from what an expert
            finds in real traces rather than guessed up front.
          </p>
          <div>
            <Button asChild>
              <Link to="/" search={{ org: orgSlug, new: true }}>
                Create your first panel
              </Link>
            </Button>
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      {head}
      {/*
        `--gap-stack` between rows, not `--gap-tight`.

        They were 8px apart while carrying 28px of padding inside, which is the exact shape of
        "tight between, loose inside" — the rows crowd each other while each one feels roomy,
        and the list reads as one block rather than as separate panels.
      */}
      {/*
        A GRID of cards, not full-width rows.

        Two things were wrong with the rows. The metric numbers were `--type-title` while the
        panel NAME was body size, so the least important thing on the row was the biggest — the
        hierarchy was upside down. And a full-width row for four short facts leaves most of the
        card empty at any real window size, which is what made the list feel like filler.

        A card is narrower than the eye has to travel, so the name reads first, the state reads
        second, and the metadata reads as metadata.
      */}
      <ul className="grid list-none grid-cols-1 gap-[var(--gap-stack)] p-0 md:grid-cols-2 xl:grid-cols-3">
        {panels.data.map((panel) => (
          <li key={panel.id}>
            <Link
              to="/p/$panelSlug"
              params={{ panelSlug: panel.slug }}
              search={{ org: orgSlug }}
              className="flex h-full flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)] hover:border-border-strong"
            >
              <span className="flex items-start gap-[var(--gap-inline)]">
                <span className="flex min-w-0 flex-1 flex-col gap-[var(--gap-tight)]">
                  {/* The name is the biggest thing on the card, which is the whole fix. */}
                  <strong className="truncate text-title font-semibold tracking-[var(--tracking-snug)]">
                    {panel.name}
                  </strong>
                  <Data className="truncate">{panel.slug}</Data>
                </span>
                {/* Top right, and the only colour on the card: it answers a question about the
                    data, which is the one thing colour is for here. */}
                <Mark tone={panel.state === 'collecting' ? 'neutral' : 'success'}>
                  {panel.state}
                </Mark>
              </span>

              {panel.current_version_id === null ? (
                <Mark tone="warning" className="self-start">
                  no live version
                </Mark>
              ) : null}

              {/*
                Metadata, and it reads as metadata: mono, small, muted labels with the VALUES in
                the foreground so the eye lands on the numbers rather than the words.
              */}
              <span className="mt-auto flex flex-wrap items-center gap-[var(--gap-inline)] border-t pt-[var(--gap-inline)]">
                <Fact
                  value={panel.trace_count}
                  label={panel.trace_count === 1 ? 'trace' : 'traces'}
                />
                <span className="text-foreground-faint">·</span>
                <Fact
                  value={panel.judge_count}
                  label={panel.judge_count === 1 ? 'judge' : 'judges'}
                />
                <Data className="ml-auto">
                  {new Date(panel.created_at).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </Data>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  )
}

/**
 * One count on a panel card. Mono and achromatic — a count is not a finding, and rule 4 of the
 * approved tokens gives colour only to numbers where the colour IS the finding.
 *
 * The VALUE is foreground and the label is muted, which is the opposite of how it first read:
 * an uppercase label above a large number made the label the thing you saw.
 */
const Fact = ({ value, label }: { value: number; label: string }) => (
  <Data>
    <span className="text-foreground tabular-nums">{value}</span> {label}
  </Data>
)
