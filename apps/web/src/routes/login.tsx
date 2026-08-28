import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { auth } from '../api/client.ts'
import { meQuery } from '../api/queries.ts'

/**
 * The login form. A real credential sign-in against a real better-auth handler over a real
 * cookie — the plumbing M0 exists to prove — with no design whatsoever, which is M4's job.
 *
 * Nothing here touches a password beyond handing it to better-auth's client. There is no
 * hashing, no token storage, and no `localStorage`: the session is an httpOnly cookie the
 * browser holds and this code cannot read, which is the property that makes it not stealable
 * by anything that manages to run script on this page.
 */
export const LoginPage = () => {
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

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
    </form>
  )
}
