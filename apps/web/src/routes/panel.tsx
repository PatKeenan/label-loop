import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { ContentSlot, PageHead } from '../components/shell/page-head.tsx'
import { Button } from '../components/ui/button.tsx'

/**
 * The scope line and title every panel section shares. The shell has already resolved the
 * panel by the time a section renders — `ConsoleLayout` draws the not-found and failed
 * states itself — so a section that gets here has one.
 */
const usePanel = () => {
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  if (context.state !== 'ready' || panel.state !== 'ready') return null
  return { orgSlug: context.orgSlug, panel }
}

/**
 * A PANEL'S OVERVIEW — its home, and at M4 its onboarding.
 *
 * This section is live at M4 rather than M6, and the change is recent enough to be worth
 * naming: ADR-0060 (a panel can COLLECT before it judges) moved into M4 during the phase 6
 * review, and a panel therefore opens here rather than on a judge list (Deviations 39–41).
 *
 * **Phase 8 builds the contents**: the collecting state, progress toward the 50-trace
 * annotation gate, and the integration snippet carrying the key issued with the panel. At M6
 * it becomes the panel's dashboard.
 */
export const PanelOverviewPage = () => {
  const resolved = usePanel()
  if (resolved === null) return null
  const { orgSlug, panel } = resolved

  return (
    <>
      <PageHead scope={[orgSlug, panel.slug]} title="Overview" />
      <ContentSlot label="Screen content · phase 8">
        <p className="m-0">
          <strong>At M4:</strong> the panel’s home while it collects — state, progress toward the
          annotation gate, and the integration snippet carrying the key issued with the panel. Drawn
          in full in <code>mockups/panel-create.html</code>.
        </p>
        <p className="m-0">
          <strong>At M6:</strong> this becomes the panel’s dashboard, and <strong>Judges</strong>{' '}
          unlocks once an eval pass exists — a judge must cite the traces and annotations that
          produced it (ADR-0061).
        </p>
      </ContentSlot>
    </>
  )
}

/**
 * KEYS — the panel's API keys: name, last four, status, issue, revoke.
 *
 * Phase 8's screen. What the SHELL owns, and what phase 7 therefore ships, is the modal
 * either action opens and the toast if the action fails — both already mounted, neither yet
 * raised by anything.
 */
export const PanelKeysPage = () => {
  const resolved = usePanel()
  if (resolved === null) return null
  const { orgSlug, panel } = resolved

  return (
    <>
      <PageHead
        scope={[orgSlug, panel.slug]}
        title="Keys"
        actions={<Button disabled>Issue key</Button>}
      />
      <ContentSlot label="Screen content · phase 8">
        <p className="m-0">
          The keys for <strong>{panel.slug}</strong>: name, last four, status. The one-time reveal
          has no close button and the revoke confirmation dismisses on all three exits — dismissing
          a reveal destroys the only copy, and not revoking is safe.
        </p>
      </ContentSlot>
    </>
  )
}
