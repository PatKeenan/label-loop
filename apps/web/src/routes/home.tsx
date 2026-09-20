import { ANNOTATION_FLOOR } from '@labelloop/contracts'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { ArrowRightIcon, BotIcon, InboxIcon, ScaleIcon } from 'lucide-react'
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

  const createLink = (label: string) => (
    <Button asChild>
      <Link to="/" search={{ org: orgSlug, new: true }}>
        {label}
      </Link>
    </Button>
  )

  // The head's Create panel action is withheld while the list is EMPTY: the empty state
  // carries that action itself, and two identical primary buttons on one screen make the
  // reader wonder whether they do different things.
  const isEmpty = panels.data?.length === 0
  const head = (
    <PageHead
      scope={[orgSlug]}
      title="Panels"
      {...(isEmpty ? {} : { actions: createLink('Create panel') })}
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

  if (panels.data.length === 0) {
    return (
      <>
        {head}
        <EmptyState action={createLink('Create panel')} />
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

/**
 * THE EMPTY STATE — where M4's demo starts, so it is a screen rather than a sentence.
 *
 * It fills the stage and centres in it. The first version was a card pinned top-left at
 * reading width, which on a real window left three-quarters of the screen empty beside a
 * paragraph — it read as a notice about the page rather than as the page.
 *
 * Three parts, each answering one question someone arriving here has:
 *
 * - **What is a panel?** Drawn, not described: the loop it sits in. The DECISION node is
 *   dashed and faded, because that is honestly where a new panel is — it collects, and judges
 *   nothing, until judges come from an eval pass (ADR-0060, ADR-0061). Drawing a decision
 *   coming out of a fresh panel would promise something the next screen does not do.
 * - **What do I do?** One primary action. The page head's copy of it is withheld while empty.
 * - **What happens after?** Three steps, so creating a panel is not a leap into the unknown:
 *   the key and snippet arrive with it, and the annotation gate is the next milestone.
 */
const EmptyState = ({ action }: { action: React.ReactNode }) => (
  <section
    aria-labelledby="empty-title"
    className="grid flex-1 place-items-center rounded-lg border border-dashed border-border-strong px-[var(--pad-panel-x)] py-[var(--space-16)]"
  >
    <div className="flex max-w-[36rem] flex-col items-center gap-[var(--gap-section)] text-center">
      <LoopDiagram />

      <div className="flex flex-col items-center gap-[var(--gap-stack)]">
        <h2
          id="empty-title"
          className="m-0 text-display font-semibold tracking-[var(--tracking-snug)]"
        >
          Create your first panel
        </h2>
        <p className="m-0 text-body text-muted-foreground">
          A panel is where your agent’s output gets judged. Send it what your agent produced and it
          captures every call — then, once judges exist, answers with a decision your code can gate
          on.
        </p>
        {action}
      </div>

      <ol className="grid w-full list-none grid-cols-1 gap-[var(--gap-stack)] border-t p-0 pt-[var(--gap-section)] text-left sm:grid-cols-3">
        <Step n={1} title="Name it">
          A name, a slug and a pass threshold. It comes with an API key.
        </Step>
        <Step n={2} title="Send traffic">
          One <code>POST</code> from your agent. The snippet is on the panel’s page.
        </Step>
        <Step n={3} title="Review">
          At {ANNOTATION_FLOOR} traces an expert can start reviewing. Judges are written from that.
        </Step>
      </ol>
    </div>
  </section>
)

/**
 * The loop a panel sits in: agent → panel → decision. Achromatic on purpose — nothing here is
 * a finding, so rule 4 of the approved tokens gives it no colour — and the one node that is
 * not true yet is drawn dashed rather than left out.
 */
const LoopDiagram = () => (
  <div aria-hidden="true" className="flex items-center gap-[var(--gap-inline)]">
    <Node icon={<BotIcon className="size-5" />} label="Your agent" />
    <ArrowRightIcon className="size-4 shrink-0 text-foreground-faint" />
    <Node icon={<InboxIcon className="size-5" />} label="Panel" emphasised />
    <ArrowRightIcon className="size-4 shrink-0 text-foreground-faint" />
    <Node icon={<ScaleIcon className="size-5" />} label="Decision" pending />
  </div>
)

const Node = ({
  icon,
  label,
  emphasised = false,
  pending = false,
}: {
  icon: React.ReactNode
  label: string
  emphasised?: boolean
  pending?: boolean
}) => (
  <div className="flex w-[var(--space-20)] flex-col items-center gap-[var(--gap-tight)]">
    <span
      className={cn(
        'grid size-[var(--space-12)] place-items-center rounded-lg border',
        emphasised && 'border-border-strong bg-card text-foreground',
        pending && 'border-dashed text-foreground-faint',
        !emphasised && !pending && 'bg-muted text-muted-foreground',
      )}
    >
      {icon}
    </span>
    <Eyebrow className={cn('whitespace-nowrap', pending && 'text-foreground-faint')}>
      {label}
    </Eyebrow>
  </div>
)

const Step = ({ n, title, children }: { n: number; title: string; children: React.ReactNode }) => (
  <li className="flex flex-col gap-[var(--gap-tight)]">
    <span className="flex items-center gap-[var(--gap-tight)]">
      <Data className="tabular-nums text-foreground-faint">{String(n).padStart(2, '0')}</Data>
      <strong className="text-ui font-semibold">{title}</strong>
    </span>
    <span className="text-ui text-muted-foreground">{children}</span>
  </li>
)
