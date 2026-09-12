import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Navigate } from '@tanstack/react-router'
import { useState } from 'react'
import { auth } from '../api/client.ts'
import { meQuery } from '../api/queries.ts'

/**
 * What the `/login` ROUTE renders, as opposed to the form itself.
 *
 * The two are separate because the form has two callers with opposite needs. `TracesPage`
 * renders `LoginPage` inline as its signed-out branch and must NOT redirect — the whole
 * point there is to show the form where the traces would be. Arriving at `/login` with a
 * live session is the other case entirely: there is nothing to sign in to, and showing the
 * form invites someone to type credentials that will not be checked.
 *
 * A component-level `<Navigate>` rather than the router's `beforeLoad` + `redirect()`,
 * because the session lives in a TanStack Query cache that the router has no context for.
 * Wiring the query client into router context to serve one redirect would be more
 * machinery than the redirect is worth; when M4 adds real redirect-after-401 the context
 * will earn itself, and this becomes a `beforeLoad`.
 */
export const LoginRoute = () => {
  const me = useQuery(meQuery)

  // Not `me.data == null` — that conflates "still asking" with "nobody". Rendering the
  // form during the first fetch would flash it at a signed-in user on every hard reload.
  if (me.isPending) return <p>Loading…</p>
  if (me.data != null) return <Navigate to="/" replace />
  return <LoginPage />
}

/**
 * The login form. A real credential sign-in against a real better-auth handler over a real
 * cookie — the plumbing M0 exists to prove — with no design whatsoever, which is M4's job.
 *
 * Nothing here touches a password beyond handing it to better-auth's client. There is no
 * hashing, no token storage, and no `localStorage`: the session is an httpOnly cookie the
 * browser holds and this code cannot read, which is the property that makes it not stealable
 * by anything that manages to run script on this page.
 *
 * ---
 *
 * **THE GITHUB BUTTON BELOW IS A THROWAWAY.** It was added during M4 phase 2 for one
 * reason: that phase ships GitHub sign-in and its manual verification says to complete a
 * sign-in "with the GitHub button", which did not exist and was not scheduled to exist until
 * phase 8. Rather than verify the OAuth round trip by pasting curl output into a browser,
 * the button exists so the flow can be driven the way a person will actually drive it.
 *
 * It is NOT the phase 8 implementation and nothing should be carried forward from it:
 *
 * - No design. Phase 7 converts the approved tokens and builds the shell (ADR-0046); phase 8
 *   rebuilds these screens inside it. Phase C's rule is rebuild-clean, never port.
 * - No feature detection. If the API has no GitHub credentials configured, this button is
 *   still rendered and the request comes back `PROVIDER_NOT_FOUND`. A real implementation
 *   asks the server what providers exist rather than assuming.
 * - No redirect-after-401. `callbackURL` is hard-coded to the console root; the plan gives
 *   that to phase 8, where the router context earns itself.
 *
 * Delete it in phase 8 rather than extending it.
 */
export const LoginPage = () => {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  /** Throwaway — see the note above this component. Phase 8 replaces it wholesale. */
  const signInWithGithub = useMutation({
    mutationFn: async () => {
      const { error } = await auth.signIn.social({
        provider: 'github',
        // Where GitHub sends the browser after the API's callback has set the cookie.
        // Hard-coded: "back where you were" is redirect-after-401, which is phase 8's.
        callbackURL: window.location.origin,
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
    // The session cookie is now set, so the question `meQuery` answered a moment ago
    // ("nobody") has a different answer. Invalidating is what re-runs it.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: meQuery.queryKey }),
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        signIn.mutate()
      }}
    >
      <h2>Sign in</h2>
      <p>
        <label htmlFor="email">Email</label>
        <br />
        <input
          id="email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
      </p>
      <p>
        <label htmlFor="password">Password</label>
        <br />
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </p>
      <button type="submit" disabled={signIn.isPending}>
        {signIn.isPending ? 'Signing in…' : 'Sign in'}
      </button>
      {signIn.error === null ? null : <p role="alert">{signIn.error.message}</p>}

      {/* Throwaway, added in M4 phase 2 to drive the OAuth round trip. See the note on
          this component: phase 8 deletes this rather than extending it. */}
      <hr />
      <p>
        <button
          type="button"
          onClick={() => signInWithGithub.mutate()}
          disabled={signInWithGithub.isPending}
        >
          {signInWithGithub.isPending ? 'Redirecting…' : 'Sign in with GitHub'}
        </button>
      </p>
      {signInWithGithub.error === null ? null : (
        <p role="alert">{signInWithGithub.error.message}</p>
      )}
    </form>
  )
}
