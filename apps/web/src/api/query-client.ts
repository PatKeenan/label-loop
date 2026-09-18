import { ERROR_SPEC } from '@labelloop/contracts'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { ApiError } from '../errors/api-error.ts'
import { meQuery } from './queries.ts'

/**
 * The console's one query client — in a module of its own because two things need it: React,
 * through the provider in `main.tsx`, and the ROUTER, through its context, so a `beforeLoad`
 * can ask whether anyone is signed in before a screen renders (M4 phase 8).
 */

/**
 * A 401 from ANY read or write means the session is gone — expired, or signed out in another
 * tab — whatever the screen was asking for at the time.
 *
 * It is answered in one place rather than on every screen: the bootstrap read is told the
 * answer it would now give (`null`, nobody), and the console layout, which already treats
 * that as "signed out", sends the browser to `/login` with the page it was on as the
 * redirect. Without this, an expired session showed each section's own load-failed state
 * with a Reload button that could only ever fail again.
 */
const onAuthError = (error: unknown) => {
  if (!(error instanceof ApiError)) return
  if (error.code === 'UNAUTHORIZED') {
    queryClient.setQueryData(meQuery.queryKey, null)
    return
  }
  // A FORBIDDEN means the console's picture of WHO THIS IS has gone stale — a role changed, or
  // a membership was removed, while the tab was open, because the console never asks for what
  // the role it holds cannot have. So re-ask `/me`, and the shell redraws for who you now are:
  // the annotator's frame, or org creation if nothing is left (ADR-0063). Only `/me` refetches;
  // the refused read is not retried, so this cannot loop.
  if (error.code === 'FORBIDDEN') {
    void queryClient.invalidateQueries({ queryKey: meQuery.queryKey })
  }
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: {
      // Whether a retry can possibly help is not a guess the client gets to make — it is
      // declared per code in the shared taxonomy, and this is where the browser honours it.
      // Retrying a 401 or a VALIDATION_ERROR is three more identical failures and three
      // times the delay before the user sees the login form or the field that is wrong.
      //
      // A failure that is NOT an `ApiError` never reached the API (offline, DNS, a proxy),
      // and those are exactly the ones worth retrying.
      retry: (failureCount, error) => {
        if (failureCount >= 2) return false
        return error instanceof ApiError ? ERROR_SPEC[error.code].retryable : true
      },
    },
  },
})
