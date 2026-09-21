import { ANNOTATION_FLOOR } from '@labelloop/contracts'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { LockIcon } from 'lucide-react'
import { Mark } from './mark.tsx'

/**
 * A PANEL'S SECTIONS — every item here belongs to the panel named in the switcher above it
 * (6b decision 4). There are no org-level entries, and that absence is the rule that lets
 * the sidebar read as one thing: *if it is in the section nav, it belongs to the panel named
 * above it* (CONSOLE_FLOW §4).
 *
 * The order follows the core product loop (PRODUCT.md §4) under an Overview that is the
 * panel's home: judge and trace → get key → annotate → axial coding → alignment → fine-tune.
 *
 * ---
 *
 * **TWO KINDS OF UNAVAILABLE, DRAWN DIFFERENTLY** (6b decision 4b, CONSOLE_FLOW R9). The
 * distinction is the whole reason this list is data rather than markup:
 *
 * - A **milestone mark** ("M5", "M6") means NOT BUILT YET. Inert sections are shown greyed
 *   out and labelled with the milestone that builds them — decided at the 6b review, on the
 *   argument that it keeps the console honest and gives later milestones something to point
 *   back at (plan open question 1, answered).
 * - A **padlock** means BUILT, AND NOT YOURS YET. Judges is locked until an eval pass
 *   exists, because a judge must cite the traces and annotations that produced it
 *   (ADR-0061). That is a different statement from "unfinished" and it gets a different mark.
 *
 * **Traces is never locked**, and that is a product decision rather than an oversight:
 * locking a customer out of their own data would be a different product.
 */
type Section =
  // `to` is spelled out per section rather than built from a slug: TanStack types `to`
  // against the route tree, so a literal is checked at compile time and a template string
  // is not. A section pointing at a route that does not exist should be a build failure.
  | {
      to: '/p/$panelSlug' | '/p/$panelSlug/traces' | '/p/$panelSlug/keys'
      label: string
      state: 'live'
    }
  | { label: string; state: 'locked'; why: string }
  | { label: string; state: 'scheduled'; milestone: string; why: string }
  // BOTH KINDS OF UNAVAILABLE AT ONCE, which is why it needs its own state: below the floor
  // annotation is not available for this panel at all (a padlock, ADR-0061), and above it the
  // section that would show the work is still being built (a milestone mark).
  | { label: string; state: 'gated'; milestone: string; why: string }

const SECTIONS: readonly Section[] = [
  // The panel's home and, at M4, its onboarding: collecting state, progress toward the
  // annotation gate, and the integration snippet. Becomes the dashboard at M6.
  { to: '/p/$panelSlug', label: 'Overview', state: 'live' },
  {
    label: 'Judges',
    state: 'locked',
    why: 'Authoring is locked until an eval pass exists (ADR-0061). The section itself is readable once judges exist.',
  },
  { to: '/p/$panelSlug/traces', label: 'Traces', state: 'live' },
  { to: '/p/$panelSlug/keys', label: 'Keys', state: 'live' },
  /**
   * ANNOTATIONS — the annotation sets this panel's annotators are working, how far each of
   * them has got, and what each of them said (ADR-0084). It is INERT until M5 phase 7 builds
   * it, and it does not leave the console.
   *
   * It used to, and that is what this row is fixing. Through phase 5 this was **Review
   * traces**, a live link out of the console and into the annotator surface, on ADR-0064's
   * reasoning that a role says what you may DO and the surface is a preference. Met in a real
   * console it read as an ambush, and the surface it landed on answers none of a developer's
   * questions — it cannot, because it deliberately shows an annotator no history (ADR-0066).
   * Staff get their own read here instead, and they get no door until it exists: no door is
   * better than a door to the wrong room.
   *
   * Gated below the floor rather than hidden, with the distance in the tooltip: the count is
   * on the Overview, and a section that vanishes at 49 traces and reappears at 50 reads as a
   * bug rather than as a threshold.
   */
  {
    label: 'Annotations',
    state: 'gated',
    milestone: 'M5',
    why: 'The annotation sets this panel’s annotators are working, and what each of them said — arrives with M5 phase 7.',
  },
  { label: 'Taxonomy', state: 'scheduled', milestone: 'M6', why: 'Arrives at M6' },
  { label: 'Alignment', state: 'scheduled', milestone: 'M6', why: 'Arrives at M6' },
  { label: 'Fine-tunes', state: 'scheduled', milestone: 'M7', why: 'Arrives at M7' },
]

const ROW =
  'flex min-h-[var(--row-min)] items-center gap-[var(--gap-inline)] rounded-md ' +
  'px-[var(--pad-field-x)] text-foreground'

/** The current-section treatment: a filled row with an inset rule down its leading edge. */
const CURRENT = 'bg-muted font-semibold shadow-[inset_var(--border-thick)_0_0_var(--color-text)]'

export const SectionNav = ({
  panelSlug,
  panelName,
  orgSlug,
  traceCount,
}: {
  panelSlug: string
  panelName: string
  orgSlug: string
  traceCount: number
}) => (
  <nav className="flex flex-col gap-px" aria-label={panelName}>
    {SECTIONS.map((section) => {
      // The one section with a condition on it: annotation opens at the floor (ADR-0061).
      if (section.state === 'gated') {
        const below = traceCount < ANNOTATION_FLOOR
        return (
          <span
            key={section.label}
            aria-disabled="true"
            title={
              below
                ? `Opens at ${ANNOTATION_FLOOR} collected traces — this panel has ${traceCount}`
                : section.why
            }
            className={cn(ROW, 'cursor-not-allowed text-foreground-faint')}
          >
            {section.label}
            {below ? (
              <LockIcon aria-hidden className="ml-auto size-3 shrink-0 text-foreground-faint" />
            ) : (
              <Mark tone="neutral" className="ml-auto">
                {section.milestone}
              </Mark>
            )}
          </span>
        )
      }
      if (section.state === 'live') {
        return (
          <Link
            key={section.label}
            to={section.to}
            params={{ panelSlug }}
            search={{ org: orgSlug }}
            // `exact` because Overview is the panel's index, so it would otherwise mark
            // itself current on every child route — "current" has to mean one row.
            //
            // `includeSearch: false` because TanStack matches search params by DEFAULT, and
            // `?org=` is on every link here but NOT on the URL you land on after signing in.
            // With the default, the whole nav silently stops highlighting on exactly the
            // path most people arrive by. Found by clicking through the running console;
            // no test would have caught it, because it is a match rule and not a route.
            activeOptions={{ exact: section.to === '/p/$panelSlug', includeSearch: false }}
            activeProps={{ className: cn(ROW, CURRENT) }}
            inactiveProps={{ className: cn(ROW, 'hover:bg-secondary') }}
          >
            {section.label}
          </Link>
        )
      }
      return (
        <span
          key={section.label}
          aria-disabled="true"
          title={section.why}
          className={cn(ROW, 'cursor-not-allowed text-foreground-faint')}
        >
          {section.label}
          {section.state === 'locked' ? (
            <LockIcon aria-hidden className="ml-auto size-3 shrink-0 text-foreground-faint" />
          ) : (
            <Mark tone="neutral" className="ml-auto">
              {section.milestone}
            </Mark>
          )}
        </span>
      )
    })}
  </nav>
)
