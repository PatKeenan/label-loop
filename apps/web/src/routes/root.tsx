import { useQueryClient } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { ConsoleShell } from '../components/shell/console-shell.tsx'
import { isStaffRole, useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { Statement } from '../components/shell/statement.tsx'
import { Button } from '../components/ui/button.tsx'
import { Toaster } from '../components/ui/sonner.tsx'
import { LoginPage } from './login.tsx'

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
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)

  if (context.state === 'pending') return <Loading />

  // Signed out: the form, not a redirect. The guard is on the SERVER — `sessionAuth` on
  // `/internal/*` — and this is only what the browser does about it. Real
  // redirect-after-401 is phase 8's, where the router context earns itself.
  if (context.state === 'signed-out') return <LoginPage />

  // Outside the shell entirely: there is no org to draw a console for. CONSOLE_FLOW Q4 — it
  // offers no way forward because none exists: membership management and org creation are
  // unscheduled, and a button to nowhere would be worse than the sentence.
  if (context.state === 'no-org') {
    return (
      <Outside>
        <Statement eyebrow="LabelLoop" title="This account isn’t in an organisation">
          <p className="m-0">
            You’re signed in, but the account hasn’t been added to any LabelLoop organisation — and
            organisations can’t be created from here yet.
          </p>
          <p className="m-0 text-muted-foreground">
            If you were expecting access, the person who administers your organisation needs to add
            this account.
          </p>
        </Statement>
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

  // A link naming an org this account cannot see. NO SILENT SWAP (6b decision 9): it says
  // nothing was switched, and it cannot name the org — the console never had its name, and
  // ADR-0057 answers an unknown and a non-member org identically.
  if (context.state === 'not-a-member') {
    return (
      <Outside>
        <Statement eyebrow="Not available" title="This link isn’t available to your account">
          <p className="m-0">
            What it points to doesn’t exist, or this account can’t see it. Nothing has been switched
            — you’re still in {context.currentOrgName}.
          </p>
          <div>
            <Button asChild>
              <Link to="/">Go to Home</Link>
            </Button>
          </div>
        </Statement>
      </Outside>
    )
  }

  // An annotator — or a guest expert, PRODUCT.md 5.1's invited SME — gets no console at M4.
  // The shell renders with no Home link, no switcher and no sections: the frame is still
  // theirs, and the org switcher at its foot is the way out for someone who also works in
  // another organisation. `isStaffRole` is an allow list, deliberately (see its comment).
  const isStaff = isStaffRole(context.role)

  return (
    <ConsoleShell
      email={context.email}
      orgSlug={context.orgSlug}
      memberships={context.memberships}
      activeOrgId={context.orgId}
      isStaff={isStaff}
      panel={panel.state === 'ready' ? { slug: panel.slug, name: panel.name } : null}
    >
      {!isStaff ? (
        <Statement eyebrow={context.orgSlug} title="Nothing to review yet">
          <p className="m-0">
            Your role in {context.orgName} is {context.role.replace('_', ' ')}. Reviewing traces
            will open here once annotation is available in LabelLoop — until then there is nothing
            in the console for this role.
          </p>
          <p className="m-0 text-muted-foreground">
            If you work in another organisation, switch to it at the foot of the sidebar.
          </p>
        </Statement>
      ) : panel.state === 'not-found' ? (
        // A panel slug this org does not have. Same posture as the org: not found and not
        // permitted are the same answer (ADR-0057, applied to panels by Deviation 14).
        <Statement eyebrow="Not available" title="This panel isn’t available to your account">
          <p className="m-0">
            It doesn’t exist in {context.orgName}, or this account can’t see it. Nothing has been
            switched.
          </p>
          <div>
            <Button asChild>
              <Link to="/" search={{ org: context.orgSlug }}>
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
const Outside = ({ children }: { children: React.ReactNode }) => (
  <div
    data-surface="console"
    className="grid min-h-screen place-items-center bg-background p-[var(--space-8)] text-foreground"
  >
    {children}
  </div>
)
