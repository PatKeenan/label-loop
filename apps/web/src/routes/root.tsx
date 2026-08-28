import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet } from '@tanstack/react-router'
import { auth } from '../api/client.ts'
import { meQuery } from '../api/queries.ts'

/**
 * The shell every route renders inside: who is signed in, and a way out.
 *
 * Unstyled on purpose (CLAUDE.md Phase C). `mockups/tokens.css` does not enter this app —
 * the mockups are disposable spec for M5's designed screens, and importing them here would
 * turn a spec into scaffold. What is being proved at M0 is that a real session reaches a
 * real typed call; anything that made it look finished would obscure that.
 */
export const RootLayout = () => {
  const queryClient = useQueryClient()
  const me = useQuery(meQuery)

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

  return (
    <>
      <header>
        <h1>LabelLoop console</h1>
        <nav>
          <Link to="/">Traces</Link>
        </nav>
        {me.data === null || me.data === undefined ? null : (
          <p>
            Signed in as {me.data.email} · {me.data.role} of {me.data.org_id}{' '}
            <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              Sign out
            </button>
          </p>
        )}
      </header>
      <hr />
      <main>
        <Outlet />
      </main>
    </>
  )
}
