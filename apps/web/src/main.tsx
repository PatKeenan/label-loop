import { ERROR_SPEC } from '@labelloop/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from './errors/api-error.ts'
import { router } from './router.tsx'

/**
 * The console's entrypoint — the browser equivalent of `apps/api/src/server.ts`: the one
 * file that touches the real world and wires the real dependencies.
 */

const queryClient = new QueryClient({
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

const container = document.getElementById('root')
if (container === null) throw new Error('index.html is missing #root')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
