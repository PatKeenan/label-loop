import { Link } from '@tanstack/react-router'
import { useConsoleContext } from '../shell/context.ts'
import { useSurface } from '../shell/surface.ts'

/**
 * THE ANNOTATOR'S FRAME — one quiet bar, and nothing else (r6, ADR-0071).
 *
 * Deliberately NOT the console shell: no sidebar, no panel switcher, no sections. The surface
 * is `data-surface="annotator"` (light + comfortable) against the console's dark + compact,
 * which is PRODUCT 5.5's two-surfaces rule expressed in one attribute — the same tokens at a
 * different setting, never a second design system.
 *
 * `useSurface` mirrors the preset onto `<html>` so portalled overlays resolve these tokens
 * rather than `:root`'s defaults (Deviation 53 of M4: the white-menu-on-dark bug, in reverse).
 */
export const ReviewFrame = ({ children }: { children: React.ReactNode }) => {
  useSurface('annotator')
  const context = useConsoleContext()
  const org = context.state === 'ready' ? context : null
  // Staff only (r6 decision 15). An annotator has no console to go back to, and offering one
  // that answers FORBIDDEN would be the UI promising what the server refuses.
  const staff = org !== null && (org.role === 'admin' || org.role === 'engineer')

  return (
    <div data-surface="annotator" className="min-h-screen bg-background text-foreground">
      <header className="flex items-center gap-[var(--gap-inline)] border-b px-[var(--pad-bar-x)] py-[var(--pad-bar-y)]">
        <Link
          to="/review"
          search={{ org: org?.orgSlug }}
          className="font-semibold text-foreground no-underline"
        >
          LabelLoop
        </Link>
        {org === null ? null : (
          <span className="font-mono text-data text-muted-foreground">{org.orgSlug}</span>
        )}
        <div className="ml-auto flex items-center gap-[var(--gap-inline)]">
          {staff ? (
            <Link
              to="/"
              search={{ org: org?.orgSlug }}
              className="text-data text-muted-foreground hover:text-foreground"
            >
              Console
            </Link>
          ) : null}
          {org === null ? null : (
            <span className="rounded-[var(--radius-control)] border bg-card px-[var(--pad-control-x)] py-[var(--pad-control-y)] font-mono text-data">
              {org.email}
            </span>
          )}
        </div>
      </header>
      {children}
    </div>
  )
}

/**
 * A waiting state: CENTRED in the stage, with few words (r6 decision 13).
 *
 * M4's version was a card pinned to the top-left, which read as a page that had failed to
 * load rather than as a state. The stakeholder steered this on 2026-09-18 after seeing it.
 */
export const Stage = ({ title, children }: { title: string; children?: React.ReactNode }) => (
  <main className="grid min-h-[calc(100vh-10rem)] place-items-center px-[var(--space-6)] py-[var(--space-8)]">
    <div className="grid w-full max-w-[32rem] gap-[var(--space-6)] text-center">
      <h1 className="m-0 text-title leading-[var(--leading-title)] font-semibold tracking-[var(--tracking-snug)]">
        {title}
      </h1>
      {children}
    </div>
  </main>
)
