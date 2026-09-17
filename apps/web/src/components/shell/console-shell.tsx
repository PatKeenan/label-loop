import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { cn } from 'cn'
import { ArrowLeftIcon } from 'lucide-react'
import { auth } from '../../api/client.ts'
import { Button } from '../ui/button.tsx'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
} from '../ui/sidebar.tsx'
import type { Membership } from './context.ts'
import { Data } from './mark.tsx'
import { OrgSwitcher } from './org-switcher.tsx'
import { PanelSwitcher } from './panel-switcher.tsx'
import { SectionNav } from './section-nav.tsx'
import { useSurface } from './surface.ts'

/**
 * THE CONSOLE'S FRAME — built once here, so phase 8's screens are things that go INSIDE
 * something that already exists rather than three screens each inventing their own layout.
 * That failure is what plan decisions 13 and 14 reorganised the phases to prevent, and it
 * reappeared once already as a copy-paste (Deviation 39a).
 *
 * Rebuilt from `mockups/console-shell.html` r3, not ported from it: CLAUDE.md's Phase C rule
 * is rebuild-clean, and the mockup's HTML is disposable spec. What IS carried across is every
 * decision its comment block numbers — they are cited individually where each one lands.
 *
 * ---
 *
 * **TWO LEVELS, ONE SIDEBAR** (6b decision 1, ADR-0056 as amended 2026-09-14). Home is the
 * organisation; a panel is the working context. The sidebar never swaps its contents: below
 * the panel switcher it shows the panel's sections when one is open, and nothing when you
 * are Home.
 *
 * **`data-surface="console"`** is set here, on the frame — dark + compact, the preset that
 * IS tone dark plus density compact. Everything inside resolves against it, which is what
 * makes the whole tree density-aware without a single component knowing the axis exists.
 * The annotator surface (M5) sets the other preset on its own frame; they share the palette
 * at two settings and are deliberately different experiences (PRODUCT.md 5.5).
 */
export const ConsoleShell = ({
  email,
  orgSlug,
  memberships,
  activeOrgId,
  panel,
  isStaff,
  children,
}: {
  email: string
  orgSlug: string
  memberships: readonly Membership[]
  activeOrgId: string
  /** The open panel, or `null` at Home. */
  panel: { slug: string; name: string } | null
  /**
   * Whether this account's role in the ACTIVE org gets the console at all. An annotator sees
   * the frame with no Home link, no switcher and no sections — there is nothing in the
   * console for that role at M4, and the alternative (an empty nav) would read as broken
   * rather than as not-yet.
   */
  isStaff: boolean
  children: React.ReactNode
}) => {
  const queryClient = useQueryClient()
  // Mirrors the preset below onto `<html>`, so portalled overlays resolve the same tokens.
  // Without it every menu, dialog and toast renders LIGHT on the dark console — see the hook.
  useSurface('console')

  const signOut = useMutation({
    mutationFn: async () => {
      await auth.signOut()
    },
    onSuccess: async () => {
      // Everything in the cache was read as this user, so none of it may be shown again.
      //
      // `invalidateQueries` rather than `clear`, and that is a correction rather than a
      // preference: `clear` empties the cache WITHOUT notifying the observers watching it,
      // so the components carry on rendering the signed-out user's rows until something
      // unrelated happens to re-render them. Invalidating refetches what is on screen —
      // `me` now answers "nobody", which is what puts the login form back.
      await queryClient.invalidateQueries()
      // Then drop what is NOT on screen. Invalidation only marks those stale, which means
      // the previous user's rows would still be in memory and rendered for a frame the
      // next time one of those views mounts.
      queryClient.removeQueries({ type: 'inactive' })
    },
  })

  const homeLinkRow =
    'flex min-h-[var(--row-min)] items-center gap-[var(--gap-inline)] rounded-md ' +
    'px-[var(--pad-field-x)]'

  return (
    /*
      `collapsible="none"` is the whole reason this uses shadcn's Sidebar rather than a
      plain grid: the container, the rail width and the sidebar theming come from the
      library, and its offcanvas machinery — the mobile Sheet, the keyboard shortcut, the
      cookie that remembers a collapsed state — does not. The console is a desktop surface
      (CONSOLE_FLOW: mobile is deliberately not drawn) with no collapse affordance in the
      approved 6b screen, and a cookie remembering view state would sit oddly beside
      ADR-0047's "both contexts live in the URL, not in storage".

      `--sidebar-width` is the component's OWN default, 16rem, verified against the copy
      actually installed rather than against memory of shadcn — one of the three values
      Deviation 36 said would arrive with the components. The approved rail was drawn to
      that number deliberately, so nothing has to be overridden here.
    */
    <SidebarProvider
      data-surface="console"
      className="h-screen min-h-0 overflow-hidden bg-background text-foreground"
    >
      <Sidebar
        collapsible="none"
        aria-label="Console"
        className={cn(
          'min-h-0 border-r px-[var(--space-3)] py-[var(--pad-panel-y)]',
          '[&>*]:min-h-0',
        )}
      >
        <SidebarHeader className="p-0">
          {/* The wordmark links Home as well (6b decision 2). */}
          <Link
            to="/"
            search={{ org: orgSlug }}
            className="px-[var(--pad-field-x)] font-semibold tracking-[var(--tracking-snug)]"
          >
            LabelLoop
          </Link>
        </SidebarHeader>

        <SidebarContent className="gap-[var(--gap-stack)] overflow-y-auto pt-[var(--gap-stack)]">
          {isStaff ? (
            <>
              {/*
              THE HOME LINK (6b decision 2). From inside a panel it carries a back arrow, so
              opening a panel reads as moving forward and leaving it as moving back. At Home
              it reads "Home" and is marked current.
            */}
              {panel === null ? (
                <span
                  aria-current="page"
                  className={cn(
                    homeLinkRow,
                    'bg-muted font-semibold shadow-[inset_var(--border-thick)_0_0_var(--color-text)]',
                  )}
                >
                  Home
                </span>
              ) : (
                <Link
                  to="/"
                  search={{ org: orgSlug }}
                  className={cn(homeLinkRow, 'hover:bg-secondary')}
                >
                  <ArrowLeftIcon aria-hidden className="size-3.5 text-muted-foreground" />
                  Home
                </Link>
              )}

              {/*
                `--gap-stack`, not `--gap-tight`. The switcher answers "which panel" and the nav
                answers "what within it" — two questions, so they get a real gap. The approved
                mockup used 4px here, but its switcher is a `details` element with no focus ring;
                ours is a button carrying the approved 4px `--shadow-focus`, so at 4px the ring and
                the first nav row touched exactly.
              */}
              <div className="flex flex-col gap-[var(--gap-stack)]">
                <PanelSwitcher
                  orgId={activeOrgId}
                  orgSlug={orgSlug}
                  activePanelSlug={panel?.slug ?? null}
                />
                {panel === null ? null : (
                  <SectionNav panelSlug={panel.slug} panelName={panel.name} orgSlug={orgSlug} />
                )}
              </div>
            </>
          ) : null}
        </SidebarContent>

        {/*
          THE FOOT: identity, organisation, sign out.

          Organisation settings are ABSENT, not disabled — admins only, and not until M8,
          when Audit log or Billing first ships (ADR-0059, CONSOLE_FLOW R4). Hiding it
          mirrors the server guard and never replaces it: an engineer who types the URL must
          get FORBIDDEN from the server, which is M8's to build and is not optional.
        */}
        <SidebarFooter className="mt-auto gap-[var(--gap-inline)] border-t p-0 pt-[var(--gap-stack)]">
          <div className="px-[var(--pad-field-x)]">
            <Data className="block truncate text-foreground">{email}</Data>
          </div>
          <OrgSwitcher memberships={memberships} activeOrgId={activeOrgId} />
          <Button
            variant="outline"
            className="w-full"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            Sign out
          </Button>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-h-0 gap-[var(--gap-stack)] overflow-y-auto px-[var(--space-8)] py-[var(--gap-section)]">
        {children}
      </SidebarInset>
    </SidebarProvider>
  )
}
