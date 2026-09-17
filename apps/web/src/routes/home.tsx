import { useConsoleContext } from '../components/shell/context.ts'
import { ContentSlot, PageHead } from '../components/shell/page-head.tsx'
import { Button } from '../components/ui/button.tsx'

/**
 * HOME — the organisation's level, and the sign-in landing.
 *
 * At M4 it holds the panel list and its empty state, which is where the demo starts. At M6 it
 * gains overview cards across panels — `console-dashboard`'s contents, for which Phase A stays
 * paused (ADR-0055) — and whatever later arrives as the financial view (PRODUCT.md 5.10).
 *
 * **Phase 8 builds the contents.** What exists here now is the frame's half: the page header
 * with its scope line, the Create panel action in the header's action slot, and the labelled
 * slot the list will replace. That is deliberate rather than a stub — see `ContentSlot`.
 */
export const HomePage = () => {
  const context = useConsoleContext()
  if (context.state !== 'ready') return null

  return (
    <>
      <PageHead
        scope={[context.orgSlug]}
        title="Home"
        actions={
          // Disabled rather than absent: the entry point is shell furniture, and phase 8
          // fills in what it opens. The panel switcher carries the same entry for the same
          // reason.
          <Button disabled>Create panel</Button>
        }
      />
      <ContentSlot label="Screen content · phase 8">
        <p className="m-0">
          <strong>At M4:</strong> the panel list, and its empty state on a database with no panel,
          where M4’s demo starts. Choosing a panel here or in the switcher opens it.
        </p>
        <p className="m-0">
          <strong>From M6:</strong> overview cards across panels above the list —{' '}
          <code>console-dashboard</code>’s contents, for which Phase A stays paused.
        </p>
      </ContentSlot>
    </>
  )
}
