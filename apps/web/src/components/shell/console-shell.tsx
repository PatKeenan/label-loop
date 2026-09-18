import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { cn } from 'cn'
import { auth } from '../../api/client.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx'
import { isStaffRole, type Membership, type OrgRole } from './context.ts'
import { CreatePanelDialog } from './create-panel-dialog.tsx'
import { forgetIssuedKeys } from './issued-key.ts'
import { Data, Mark } from './mark.tsx'
import { useMenuFocusReturn } from './menu-focus.ts'
import { OrgSwitcher } from './org-switcher.tsx'
import { PanelSwitcher } from './panel-switcher.tsx'
import { SectionNav } from './section-nav.tsx'
import { useSurface } from './surface.ts'

/**
 * THE CONSOLE'S FRAME — a persistent top bar, and a sidebar that exists only inside a panel.
 *
 * ---
 *
 * **THIS SUPERSEDES ADR-0056's "two levels, one persistent sidebar"** (see ADR-0062). The 6b
 * review chose one sidebar over a swapping one, on a reason worth restating because it is
 * what shaped the replacement: *a swapping sidebar hides Home behind a back button, where a
 * persistent one with a back arrow keeps Home without losing it.*
 *
 * That objection was right, and it is answered here by the TOP BAR rather than by the
 * sidebar. The bar carries the wordmark, the scope, the organisation and the account at BOTH
 * levels, so Home is never behind anything — which a sidebar that simply vanished would not
 * have achieved. That is why this is not the rejected design returning.
 *
 * **What the review could not see.** The 6b and 6c mockups drew Home with its content slot
 * full of descriptive prose, so the rail never looked empty beside it. Rendered against a
 * real organisation at a real width, the sidebar at Home was a wordmark, a Home row, a panel
 * switcher, and then roughly nine hundred pixels of nothing. The stakeholder saw it in one
 * look; no amount of reviewing the drawing would have shown it.
 *
 * **The rule this makes structural.** CONSOLE_FLOW §4 already said *"Home is the list"*, and
 * that every nav item belongs to the panel named above it. A sidebar that exists only inside
 * a panel turns that from a convention into a fact: at Home there are no panel nav items,
 * because there is no panel nav.
 *
 * `data-surface="console"` is set here — dark + compact — and mirrored onto the document by
 * `useSurface`, so portalled overlays resolve the same tokens.
 */
export const ConsoleShell = ({
  email,
  orgSlug,
  memberships,
  activeOrgId,
  panel,
  role,
  children,
}: {
  email: string
  orgSlug: string
  memberships: readonly Membership[]
  activeOrgId: string
  /** The open panel, or `null` anywhere at the organisation's level. */
  panel: { slug: string; name: string } | null
  /**
   * This account's role in the ACTIVE org, which decides what the frame offers. An annotator
   * sees the bar and nothing else — there is nothing in the console for that role at M4, and
   * an empty nav would read as broken rather than as not-yet. Every gate below MIRRORS a
   * server guard and replaces none of them (CONVENTIONS "Keys & auth").
   */
  role: OrgRole
  children: React.ReactNode
}) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  // The console preset — dark + COMPACT. It briefly ran dark + comfortable, which grew 13px
  // body text to 17px and read as everything simply getting bigger rather than as anything
  // gaining room. Dense product UI keeps small type and spends its room on SPACE, so the
  // compact density's SPACING was opened in tokens.css instead and its type left alone.
  useSurface('console')
  const { triggerProps, contentProps } = useMenuFocusReturn()

  const signOut = useMutation({
    mutationFn: async () => {
      await auth.signOut()
    },
    onSuccess: async () => {
      // The one-time key plaintext lives outside the query cache, so nothing below reaches
      // it. A credential minted as one account must not survive into the next.
      forgetIssuedKeys()
      // Everything in the cache was read as this user, so none of it may be shown again.
      // `clear` BEFORE navigating, and it is the order that matters: `/login`'s `beforeLoad`
      // asks who is signed in, and a cache still holding this user would answer "you are"
      // and bounce straight back. `clear` notifies no observer, so this screen does not
      // re-render as signed out in the meantime — which would send it to `/login` with THIS
      // page as the redirect, when signing out is a request to leave, not to come back.
      queryClient.clear()
      await navigate({ to: '/login', replace: true })
    },
  })

  const isStaff = isStaffRole(role)
  const showSidebar = isStaff && panel !== null

  return (
    <div
      data-surface="console"
      className="grid h-screen min-h-0 grid-rows-[auto_1fr] overflow-hidden bg-background text-foreground"
    >
      {/*
        THE TOP BAR — present at every level, which is the whole point. It is what makes a
        sidebar that comes and goes safe: whatever screen you are on, the way out of it and
        the organisation you are in are in the same place.
      */}
      {/*
        `--pad-bar-*`, a token added with this bar: a bar's height follows its controls, where
        a panel's padding makes it enormous. It replaced a hard-coded `--space-2` that ignored
        the density axis entirely and stayed cramped whatever the rest of the console did.
      */}
      <header className="flex items-center gap-[var(--gap-inline)] border-b border-border-strong bg-sidebar px-[var(--pad-bar-x)] py-[var(--pad-bar-y)]">
        <Link
          to="/"
          search={{ org: orgSlug }}
          className="font-semibold tracking-[var(--tracking-snug)]"
        >
          LabelLoop
        </Link>

        {/* The scope as a trail rather than a heading: at Home it is the organisation alone. */}
        <span className="flex min-w-0 items-center gap-[var(--gap-tight)]">
          <Data>{orgSlug}</Data>
          {panel === null ? null : (
            <>
              <span className="text-foreground-faint">/</span>
              <Data className="truncate text-foreground">{panel.slug}</Data>
            </>
          )}
        </span>

        <div className="ml-auto flex items-center gap-[var(--gap-inline)]">
          <OrgSwitcher memberships={memberships} activeOrgId={activeOrgId} />

          <DropdownMenu>
            <DropdownMenuTrigger
              {...triggerProps}
              className="flex min-h-[var(--row-min)] items-center gap-[var(--gap-tight)] rounded-md border bg-secondary px-[var(--pad-field-x)] hover:border-border-strong"
            >
              <Data className="max-w-[16rem] truncate text-foreground">{email}</Data>
            </DropdownMenuTrigger>
            <DropdownMenuContent {...contentProps} align="end">
              {/*
                Organisation settings: admins only, and ABSENT until M8, when Audit log or
                Billing first ships (ADR-0059). Shown disabled with its milestone rather than
                hidden, on the same reasoning as the inert nav sections — it keeps the console
                honest about what is not built. But only to an ADMIN: showing an engineer a
                disabled item they could never use tells them nothing about the product's
                direction. This mirrors the server guard and never replaces it — an engineer
                who types the URL must get FORBIDDEN from the server, which is M8's to build.
              */}
              {role === 'admin' ? (
                <>
                  <DropdownMenuItem
                    disabled
                    className="flex min-h-[var(--row-min)] items-center gap-[var(--gap-inline)]"
                  >
                    Organisation settings
                    <Mark tone="neutral" className="ml-auto">
                      M8
                    </Mark>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem
                onSelect={() => signOut.mutate()}
                disabled={signOut.isPending}
                className="min-h-[var(--row-min)]"
              >
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div
        className={cn(
          'grid min-h-0 overflow-hidden',
          showSidebar ? 'grid-cols-[var(--sidebar-width)_1fr]' : 'grid-cols-1',
        )}
        // shadcn's Sidebar component defaults this to 16rem and the approved rail was drawn to
        // that number (Deviation 36). Stated here because this frame is a plain grid: the
        // console is a desktop surface with no collapse, and the provider's offcanvas
        // machinery would be scaffolding for behaviour nothing has asked for.
        style={{ '--sidebar-width': '16rem' } as React.CSSProperties}
      >
        {showSidebar && panel !== null ? (
          <aside
            aria-label={panel.name}
            className="flex min-h-0 flex-col gap-[var(--gap-stack)] overflow-y-auto border-r bg-sidebar px-[var(--space-3)] py-[var(--pad-panel-y)] text-sidebar-foreground"
          >
            {/*
              The switcher stays IN the sidebar rather than moving to the bar, because it is
              panel context and the sidebar is now exactly that. Jumping between panels
              without going Home still works; choosing one from nothing is Home's job, which
              is what "Home is the list" means.
            */}
            <PanelSwitcher orgId={activeOrgId} orgSlug={orgSlug} activePanelSlug={panel.slug} />
            <SectionNav panelSlug={panel.slug} panelName={panel.name} orgSlug={orgSlug} />
          </aside>
        ) : null}

        {/*
          `--gap-section` BETWEEN the stage's sections — the page head, the gate, the snippet —
          not `--gap-stack`, which is the spacing for items WITHIN one. That token existed for
          exactly this distance and was going unused while every section sat a stack-gap apart.
        */}
        <main className="flex min-h-0 flex-col gap-[var(--gap-section)] overflow-y-auto px-[var(--space-8)] py-[var(--gap-section)]">
          {children}
        </main>

        {/*
          One dialog, mounted once, opened by `?new` from either of its two triggers — Home's
          button and the panel switcher's menu item. Rendering it here rather than beside each
          trigger is what keeps it ONE dialog: two instances would be two pieces of form state
          that could disagree.

          Staff only, mirroring `requireRole('admin', 'engineer')` on `POST /internal/panels`:
          `?new` is a URL anyone can type, and a form that can only end in FORBIDDEN is not
          one to offer.
        */}
        {isStaff ? <CreatePanelDialog /> : null}
      </div>
    </div>
  )
}
