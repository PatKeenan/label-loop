import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { auth } from '../api/client.ts'
import { meQuery, signInMethodsQuery } from '../api/queries.ts'
import { safeRedirect } from '../api/redirect.ts'
import { Eyebrow } from '../components/shell/mark.tsx'
import { Statement } from '../components/shell/statement.tsx'
import { useSurface } from '../components/shell/surface.ts'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'

/**
 * The `/login` route. Whether to be here at all is decided before this renders — the route's
 * `beforeLoad` sends a signed-in visitor on to their target — so this only reads where
 * "afterwards" is, already validated as a path on this origin (`api/redirect.ts`).
 */
export const LoginRoute = () => {
  const { redirect } = useSearch({ from: '/login' })
  // Validated by the route already; checked again here, at the point of use, because the
  // router's search merging once made that validation silently a no-op.
  return <LoginPage redirectTo={safeRedirect(redirect) ?? '/'} />
}

/**
 * The login form. A real credential sign-in against a real better-auth handler over a real
 * cookie, now on the approved tokens.
 *
 * Nothing here touches a password beyond handing it to better-auth's client. There is no
 * hashing, no token storage, and no `localStorage`: the session is an httpOnly cookie the
 * browser holds and this code cannot read, which is the property that makes it not stealable
 * by anything that manages to run script on this page.
 *
 * **Signed out, this screen is deliberately OUTSIDE the shell.** There is nothing to
 * navigate — CONSOLE_FLOW §3 lists Sign in under "outside the console" for that reason.
 *
 * ---
 *
 * **Each door is drawn only if the API will open it.** The phase 2 GitHub button rendered
 * unconditionally and came back `PROVIDER_NOT_FOUND` on any clone without GitHub credentials
 * (Deviation 11); the password form had the mirror-image problem, drawn in production where
 * ADR-0049 disables it. Both are now asked of `GET /internal/sign-in-methods`, which reads the
 * options better-auth was built with — so "offered here" and "accepted there" are one fact.
 *
 * Both doors lead back to where you were: the password form navigates to `redirectTo`, and
 * GitHub is handed it as `callbackURL`, so the round trip through github.com ends on the
 * same page `beforeLoad` sent you away from.
 */
export const LoginPage = ({ redirectTo }: { redirectTo: string }) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const methods = useQuery(signInMethodsQuery)

  const signInWithGithub = useMutation({
    mutationFn: async () => {
      const { error } = await auth.signIn.social({
        provider: 'github',
        // Where GitHub sends the browser after the API's callback has set the cookie: the
        // page that sent you here. Absolute, because the API's callback does the redirecting
        // and does not know the console's origin; better-auth checks it against its trusted
        // origins before following it.
        callbackURL: `${window.location.origin}${redirectTo}`,
      })
      if (error) throw new Error(error.message ?? 'GitHub sign-in failed.')
    },
  })

  const signIn = useMutation({
    mutationFn: async () => {
      const { error } = await auth.signIn.email({ email, password })
      // better-auth's client returns failures rather than throwing them, so this is where
      // one becomes an exception TanStack Query can put in `signIn.error`.
      if (error) throw new Error(error.message ?? 'Sign-in failed.')
    },
    onSuccess: async () => {
      // Nothing read before this sign-in may be shown after it: it may have been read as a
      // DIFFERENT account, the one whose session just expired. `clear` is safe here, where it
      // is not on sign-out, because nothing on this screen is observing the cache.
      queryClient.clear()
      // The session cookie is now set, so the question `meQuery` answered a moment ago
      // ("nobody") has a different answer — asked now, so the console route's `beforeLoad`
      // finds it answered rather than redirecting back here on the stale one.
      await queryClient.fetchQuery(meQuery)
      await navigate({ href: redirectTo, replace: true })
    },
  })

  if (methods.isPending) return <Frame>Loading…</Frame>

  if (methods.error !== null) {
    return (
      <Frame>
        <Statement
          tone="fail"
          title="LabelLoop couldn’t be reached"
          actions={
            <Button variant="outline" onClick={() => void methods.refetch()}>
              Reload
            </Button>
          }
        >
          <p className="m-0">The sign-in page could not ask the API how to sign in.</p>
        </Statement>
      </Frame>
    )
  }

  const { email_password: offersPassword, github: offersGithub } = methods.data

  // An operator's mistake, not a visitor's: `config.ts` refuses to boot production without
  // GitHub, so this is a non-production deployment with passwords turned off by hand. Said
  // plainly rather than drawn as an empty card with a heading and nothing to press.
  if (!offersPassword && !offersGithub) {
    return (
      <Frame>
        <Statement eyebrow="LabelLoop" title="No way to sign in is configured">
          <p className="m-0">
            This deployment accepts neither a password nor GitHub. Whoever runs it needs to enable
            one.
          </p>
        </Statement>
      </Frame>
    )
  }

  return (
    <Frame>
      <div className="flex w-full max-w-[26rem] flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]">
        <div className="flex flex-col gap-[var(--gap-tight)]">
          <Eyebrow>LabelLoop</Eyebrow>
          <h1 className="text-title font-semibold tracking-[var(--tracking-snug)]">Sign in</h1>
        </div>

        {offersPassword ? (
          <form
            className="flex flex-col gap-[var(--gap-stack)]"
            onSubmit={(event) => {
              event.preventDefault()
              signIn.mutate()
            }}
          >
            <div className="flex flex-col gap-[var(--gap-tight)]">
              <label htmlFor="email" className="text-ui text-muted-foreground">
                Email
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>

            <div className="flex flex-col gap-[var(--gap-tight)]">
              <label htmlFor="password" className="text-ui text-muted-foreground">
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>

            <Button type="submit" disabled={signIn.isPending}>
              {signIn.isPending ? 'Signing in…' : 'Sign in'}
            </Button>
            {signIn.error === null ? null : (
              <p role="alert" className="m-0 text-ui text-fail">
                {signIn.error.message}
              </p>
            )}
          </form>
        ) : null}

        {/* "or" only when there IS an either. */}
        {offersPassword && offersGithub ? (
          <div className="flex items-center gap-[var(--gap-inline)]">
            <span className="h-px flex-1 bg-border" />
            <Eyebrow>or</Eyebrow>
            <span className="h-px flex-1 bg-border" />
          </div>
        ) : null}

        {offersGithub ? (
          <>
            <Button
              type="button"
              // The primary door when it is the only one — production, per ADR-0049.
              variant={offersPassword ? 'outline' : 'default'}
              onClick={() => signInWithGithub.mutate()}
              disabled={signInWithGithub.isPending}
            >
              {signInWithGithub.isPending ? 'Redirecting…' : 'Sign in with GitHub'}
            </Button>
            {signInWithGithub.error === null ? null : (
              <p role="alert" className="m-0 text-ui text-fail">
                {signInWithGithub.error.message}
              </p>
            )}
          </>
        ) : null}
      </div>
    </Frame>
  )
}

/**
 * The signed-out page. `data-surface="console"` because the palette is still the console's —
 * this is the engineer's door, not the annotator's — but there is no shell around it.
 */
const Frame = ({ children }: { children: React.ReactNode }) => {
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
