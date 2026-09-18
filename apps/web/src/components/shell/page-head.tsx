import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { Data } from './mark.tsx'

/**
 * The stage's header: the scope line, the title, and the screen's actions.
 *
 * **The scope line is where the org stays visible.** The 6b shell moved the organisation to
 * the FOOT of the sidebar because it is the least-touched control in the console — most
 * accounts have one membership and never change it — and this line is what pays for that:
 * `fernhill-support / triage-routing`, in mono, on every screen, so the org is legible
 * without occupying the top slot (CONSOLE_FLOW §4).
 *
 * Slugs, not names, and that is deliberate: a slug is what appears in the URL and in an API
 * call, so the line doubles as "which object am I looking at" for someone about to write a
 * request against it.
 */
export const PageHead = ({
  scope,
  title,
  titlePlacement = 'title',
  meta,
  actions,
  back,
  className,
  ...props
}: {
  /**
   * A way back one level, drawn ABOVE the trail — for a page deeper than a section (one trace),
   * where the reader most likely arrived from a list and wants it back in one click. The trail
   * below also links, for going further up.
   */
  back?: React.ReactNode
  /**
   * Slugs, outermost first: `[orgSlug]` at Home, `[orgSlug, panelSlug]` in a panel. A segment
   * may be a LINK — the trail is where people look for "up one level", so a page deeper than a
   * section (one trace) makes its trail the way back rather than a button across the screen.
   */
  scope: readonly React.ReactNode[]
  /**
   * The page's name. In `'title'` placement (every page today) it is its own row under the
   * trail; in `'trail'` placement it is the trail's LAST segment — not a link, styled as the
   * title — so "where you are" reads as the end of the path and the header loses a row. Only
   * the trace page uses `'trail'` so far; moving every page over is a noted follow-up
   * (docs/PARKING_LOT.md), decided once it has been lived with on one page.
   */
  title: React.ReactNode
  titlePlacement?: 'title' | 'trail'
  /** Muted metadata under the header's name — the trace's timestamp, for one. */
  meta?: React.ReactNode
  actions?: React.ReactNode
} & Omit<React.ComponentProps<'header'>, 'title'>) => (
  <header
    className={cn(
      'flex items-end gap-[var(--gap-inline)] border-b border-border-strong',
      'pb-[var(--gap-stack)]',
      className,
    )}
    {...props}
  >
    <div className="flex min-w-0 flex-col gap-[var(--gap-tight)]">
      {back === undefined ? null : <div className="mb-[var(--gap-tight)]">{back}</div>}
      <div className="flex flex-wrap items-baseline gap-[var(--gap-tight)]">
        {scope.map((segment, index) => (
          <Data
            // Position is the identity: a trail is an ordered path, not a set.
            // biome-ignore lint/suspicious/noArrayIndexKey: the trail never reorders.
            key={index}
            // Links in the trail read as links on hover — underline, full contrast — and stay
            // quiet otherwise, so a trail of links does not shout over the title below it.
            className="[&_a]:underline-offset-4 [&_a:hover]:text-foreground [&_a:hover]:underline"
          >
            {index === 0 ? null : (
              <span className="mr-[var(--gap-tight)] text-foreground-faint">/</span>
            )}
            {segment}
          </Data>
        ))}
        {titlePlacement === 'trail' ? (
          // The current page, ending the path: the page's h1, so it is still the heading a
          // screen reader lands on, and never a link — you are already here.
          <h1 className="m-0 flex min-w-0 items-baseline gap-[var(--gap-tight)] text-title font-semibold tracking-[var(--tracking-snug)]">
            <span className="font-mono text-data font-normal text-foreground-faint">/</span>
            <span className="min-w-0 break-all">{title}</span>
          </h1>
        ) : null}
      </div>
      {titlePlacement === 'title' ? (
        <h1 className="text-title font-semibold tracking-[var(--tracking-snug)]">{title}</h1>
      ) : null}
      {meta === undefined ? null : <div className="mt-[var(--gap-tight)]">{meta}</div>}
    </div>
    {actions === undefined ? null : (
      <div className="ml-auto flex gap-[var(--gap-inline)]">{actions}</div>
    )}
  </header>
)

/**
 * The trail for any page inside a panel — `org / panel`, both LINKS: the org to Home (the panel
 * list), the panel to its Overview. One helper so every panel page's trail behaves the same;
 * Home's own trail stays plain, because its only segment would link to itself.
 */
export const panelTrail = (orgSlug: string, panelSlug: string): React.ReactNode[] => [
  <Link key="org" to="/" search={{ org: orgSlug }}>
    {orgSlug}
  </Link>,
  <Link key="panel" to="/p/$panelSlug" params={{ panelSlug }} search={{ org: orgSlug }}>
    {panelSlug}
  </Link>,
]

/**
 * The look of the small "← label" link a deep page puts above its trail (`PageHead`'s `back`).
 * A class, not a wrapper component: wrapping TanStack's `Link` generically loses its route
 * typing, so the caller keeps a real, typed `Link` and borrows the style.
 */
export const BACK_LINK =
  'inline-flex items-center gap-[var(--gap-tight)] text-ui text-muted-foreground hover:text-foreground'
