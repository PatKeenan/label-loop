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
  actions,
  className,
  ...props
}: {
  /** Slugs, outermost first: `[orgSlug]` at Home, `[orgSlug, panelSlug]` in a panel. */
  scope: readonly string[]
  title: React.ReactNode
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
      <div className="flex flex-wrap items-center gap-[var(--gap-tight)]">
        {scope.map((segment, index) => (
          <Data key={segment}>
            {index === 0 ? null : (
              <span className="mr-[var(--gap-tight)] text-foreground-faint">/</span>
            )}
            {segment}
          </Data>
        ))}
      </div>
      <h1 className="text-title font-semibold tracking-[var(--tracking-snug)]">{title}</h1>
    </div>
    {actions === undefined ? null : (
      <div className="ml-auto flex gap-[var(--gap-inline)]">{actions}</div>
    )}
  </header>
)

/**
 * The dashed, labelled slot standing in for a screen phase 8 builds.
 *
 * It is deliberately NOT an empty div or a "coming soon" page. The 6b mockup drew every
 * unbuilt screen this way for one reason — an inert surface that looks like product is how a
 * demo makes a promise the build has not kept — and the same reasoning applies once it is
 * real code. It says which milestone owns it, in the console, to the person reading it.
 */
export const ContentSlot = ({
  label,
  children,
  className,
  ...props
}: { label: string } & React.ComponentProps<'section'>) => (
  <section
    aria-label="Screen content slot"
    className={cn(
      'grid flex-1 place-content-center justify-items-center gap-[var(--gap-tight)]',
      'min-h-[calc(var(--space-20)*4)] rounded-lg border border-dashed border-border-strong',
      'bg-muted px-[var(--pad-panel-x)] py-[var(--pad-panel-y)] text-center',
      className,
    )}
    {...props}
  >
    <span className="font-mono text-micro uppercase tracking-[var(--tracking-micro)] text-muted-foreground">
      {label}
    </span>
    <div className="flex max-w-[var(--measure)] flex-col gap-[var(--gap-inline)] text-body text-muted-foreground">
      {children}
    </div>
  </section>
)
