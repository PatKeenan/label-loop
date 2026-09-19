import { can } from '@labelloop/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, useRouter } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ConsoleShell } from '../components/shell/console-shell.tsx'
import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { Statement } from '../components/shell/statement.tsx'
import { useSurface } from '../components/shell/surface.ts'
import { Button } from '../components/ui/button.tsx'
import { Toaster } from '../components/ui/sonner.tsx'
import { CreateOrgPage } from './create-org.tsx'

/**
 * The root route's component: the toaster, and whatever `/login` or the console layout
 * renders. It holds no chrome of its own — the frame is `ConsoleLayout`'s, because `/login`
 * has nothing to navigate and must not be inside it.
 */
export const RootLayout = () => (
  <>
    <Outlet />
    {/*
      ERROR SURFACE 3 (CONSOLE_FLOW §6), mounted once at the root so it outlives any screen
      that navigates away while an action is still in flight. It is for an ACTION that
      failed — never a failed load, which replaces the content instead — and it never
      dismisses itself. See `ui/sonner.tsx` for why that is a decision and not a default.

      Nothing in phase 7 raises one: the first action that can fail is phase 8's revoke. It
      is mounted now because it is shell furniture, and the point of building the frame here
      is that phase 8's screens find it already standing.
    */}
    <Toaster />
  </>
)

/**
 * THE CONSOLE LAYOUT — everything that is not `/login` renders inside this.
 *
 * It is a pathless layout route, so the shell MOUNTS ONCE and survives navigation between
 * sections: switching from Traces to Keys does not re-run the session read or re-open the
 * rail. That is also what makes "the sidebar never swaps its contents" (6b decision 1) true
 * structurally rather than by each screen redrawing the same rail — the failure Deviation 39a
 * caught in the mockup itself.
 *
 * Every state the 6b screen draws outside the normal case is resolved here, because each one
 * is a statement about WHO IS ASKING rather than about a screen.
 */
export const ConsoleLayout = () => {
  const queryClient = useQueryClient()
  const context = useConsoleContext()
  useRedirectWhenSignedOut(context.state === 'signed-out')
  // Resolved only for a role that can read panels. `GET /internal/panels` is
  // `requirePermission({ panel: ['read'] })`, so for anyone else it could only answer
  // FORBIDDEN — and that screen is never drawn for them anyway (see `readsPanels` below).
  const panel = usePanelContext(
    context.state === 'ready' && can(context.role, { panel: ['read'] }) ? context.orgId : null,
  )

  if (context.state === 'pending') return <Loading />

  // Signed out WHILE HERE — the session ended under an open screen, and a 401 from some read
  // told the bootstrap query so (`api/query-client.ts`). Arriving signed out never reaches
  // this: the console route's `beforeLoad` redirects first. Both go through that one
  // `beforeLoad` — see `useRedirectWhenSignedOut` — so there is one place that builds the
  // redirect. The guard is the SERVER's; this is what the browser does about its answer.
  if (context.state === 'signed-out') return <Loading />

  // Outside the shell entirely: there is no org to draw a console for — so the screen is the
  // way to make one (ADR-0063). It used to be a statement with no way forward, and it was
  // where every genuinely new GitHub sign-in landed.
  if (context.state === 'no-org') {
    return (
      <Outside>
        <CreateOrgPage email={context.email} />
      </Outside>
    )
  }

  if (context.state === 'failed') {
    return (
      <Outside>
        <Statement tone="fail" title="LabelLoop couldn’t be reached">
          <p className="m-0">The console could not read your session. Nothing has been changed.</p>
        </Statement>
      </Outside>
    )
  }

  // A link naming an org this account cannot see resolves to the org it is STILL in, and the
  // shell renders AROUND the message. NO SILENT SWAP (6b decision 9) — and the sidebar stays
  // usable, which is surface 2's defining property (CONSOLE_FLOW §6). Rendering this as a
  // bare page instead was the first draft, and it contradicted both.
  const org = context.state === 'not-a-member' ? context.fallback : context
  const notAMember = context.state === 'not-a-member'

  // A role that cannot read panels — an annotator, or a guest expert (PRODUCT.md 5.1's invited
  // SME) — gets no console: the console's every screen is a panel's. The shell renders with no
  // Home link, no switcher and no sections: the frame is still theirs, and the org switcher in
  // the top bar is the way out for someone who also works in another organisation.
  const readsPanels = can(org.role, { panel: ['read'] })

  return (
    <ConsoleShell
      email={org.email}
      orgSlug={org.orgSlug}
      memberships={org.memberships}
      activeOrgId={org.orgId}
      role={org.role}
      panel={panel.state === 'ready' ? { slug: panel.slug, name: panel.name } : null}
    >
      {notAMember ? (
        // It cannot name the org that was ASKED for: the console never had its name, and
        // ADR-0057 answers an unknown and a non-member org identically.
        <Statement eyebrow="Not available" title="This link isn’t available to your account">
          <p className="m-0">
            What it points to doesn’t exist, or this account can’t see it. Nothing has been switched
            — you’re still in {org.orgName}.
          </p>
          <div>
            <Button asChild>
              <Link to="/" search={{ org: org.orgSlug }}>
                Go to Home
              </Link>
            </Button>
          </div>
        </Statement>
      ) : !readsPanels ? (
        <Statement eyebrow={org.orgSlug} title="Nothing to review yet">
          <p className="m-0">
            Your role in {org.orgName} is {org.role.replace('_', ' ')}. Reviewing traces will open
            here once annotation is available in LabelLoop — until then there is nothing in the
            console for this role.
          </p>
          <p className="m-0 text-muted-foreground">
            If you work in another organisation, switch to it from the organisation menu at the top.
          </p>
        </Statement>
      ) : panel.state === 'not-found' ? (
        // A panel slug this org does not have. Same posture as the org: not found and not
        // permitted are the same answer (ADR-0057, applied to panels by Deviation 14).
        <Statement eyebrow="Not available" title="This panel isn’t available to your account">
          <p className="m-0">
            It doesn’t exist in {org.orgName}, or this account can’t see it. Nothing has been
            switched.
          </p>
          <div>
            <Button asChild>
              <Link to="/" search={{ org: org.orgSlug }}>
                Go to Home
              </Link>
            </Button>
          </div>
        </Statement>
      ) : panel.state === 'failed' ? (
        <Statement
          tone="fail"
          title="This panel couldn’t be loaded"
          actions={
            <Button
              variant="outline"
              onClick={() => void queryClient.invalidateQueries({ queryKey: ['panels'] })}
            >
              Reload
            </Button>
          }
        >
          <p className="m-0">The panel list could not be read. Nothing has been changed.</p>
        </Statement>
      ) : (
        <Outlet />
      )}
    </ConsoleShell>
  )
}

/**
 * When the session ends under an open screen, re-run the route's `beforeLoad`, which finds
 * nobody signed in and redirects to `/login` with this page as the way back.
 *
 * NOT a `<Navigate>`, which was the first draft and hung the tab. `Navigate` navigates again
 * whenever its props object changes, and a `search={{ redirect: location.href }}` is a new
 * object on every render — while each navigation re-renders this layout. `router.invalidate()`
 * in an effect keyed on a boolean runs once per sign-out, and reuses the redirect the route
 * already builds instead of building a second one here.
 */
const useRedirectWhenSignedOut = (signedOut: boolean) => {
  const router = useRouter()
  useEffect(() => {
    if (signedOut) void router.invalidate()
  }, [signedOut, router])
}

/** The console's loading state, at the one moment there is no shell to put it in. */
const Loading = () => (
  <Outside>
    <p className="text-muted-foreground">Loading…</p>
  </Outside>
)

/**
 * A centred page with no sidebar, for the states that exist BEFORE there is a console to
 * draw: no membership, an unreadable session, a link to an org this account cannot see.
 * `data-surface="console"` so the palette is the console's even where the frame is not.
 */
const Outside = ({ children }: { children: React.ReactNode }) => {
  // The console preset — dark + COMPACT. It briefly ran dark + comfortable, which grew 13px
  // body text to 17px and read as everything simply getting bigger rather than as anything
  // gaining room. Dense product UI keeps small type and spends its room on SPACE, so the
  // compact density's SPACING was opened in tokens.css instead and its type left alone.
  useSurface('console')
  return (
    <div
      data-surface="console"
      className="grid min-h-screen place-items-center bg-background p-[var(--space-8)] text-foreground"
    >
      {children}
    </div>
  )
}
