import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { queryClient } from './api/query-client.ts'
import { router } from './router.tsx'
// The theme. ADR-0046: `mockups/tokens.css` converted into shadcn's convention, and the
// one place this app decides anything about colour, type, spacing or density.
import './styles/tokens.css'

/**
 * The console's entrypoint — the browser equivalent of `apps/api/src/server.ts`: the one
 * file that touches the real world and wires the real dependencies. The query client is
 * built in `api/query-client.ts` because the router needs it too, as context.
 */

const container = document.getElementById('root')
if (container === null) throw new Error('index.html is missing #root')

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
