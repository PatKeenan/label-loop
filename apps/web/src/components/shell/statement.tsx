import { cn } from 'cn'
import { ApiError } from '../../errors/api-error.ts'
import { Button } from '../ui/button.tsx'
import { Data, Eyebrow, Mark } from './mark.tsx'

/**
 * ERROR SURFACE 2 of the three the 6b shell defines (CONSOLE_FLOW §6): the one that replaces
 * the CONTENT when this screen cannot be shown — a failed load, a refused role, a link to
 * something this account cannot see.
 *
 * Two properties are the point of it, and both are decisions rather than styling:
 *
 * - **The sidebar stays usable.** This renders inside the stage, never over it. Whatever went
 *   wrong with this screen, navigating away from it is exactly what the person wants to do.
 * - **A failed load offers Reload; nothing else offers a retry.** A person re-issuing a READ
 *   is always safe, so the button is offered whatever the taxonomy says — the `retryable`
 *   flag governs AUTOMATIC retries, which is a different question (`main.tsx` honours it for
 *   those). An action that failed does not belong here at all; it belongs in the toast.
 *
 * Surface 1 is beside a field and is the form's own; surface 3 is the toast in `toaster.tsx`.
 */
export const Statement = ({
  tone = 'plain',
  eyebrow,
  mark,
  title,
  children,
  requestId,
  actions,
  className,
  ...props
}: {
  /** `fail` draws the inset rule in the fail colour — a failed LOAD, not a missing thing. */
  tone?: 'plain' | 'fail'
  eyebrow?: React.ReactNode
  mark?: React.ReactNode
  title: React.ReactNode
  requestId?: string | undefined
  actions?: React.ReactNode
} & Omit<React.ComponentProps<'section'>, 'title'>) => (
  <section
    // `alert` so a screen reader is told this replaced what was asked for, rather than
    // leaving it to be discovered by reading.
    role="alert"
    className={cn(
      'flex max-w-[var(--measure)] flex-col gap-[var(--gap-stack)] self-start rounded-lg',
      'border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]',
      tone === 'fail' && 'shadow-[inset_var(--border-thick)_0_0_var(--state-fail-mark)]',
      className,
    )}
    {...props}
  >
    {eyebrow === undefined && mark === undefined ? null : (
      <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
        {mark}
        {eyebrow === undefined ? null : <Eyebrow>{eyebrow}</Eyebrow>}
      </div>
    )}
    <h2 className="text-title font-semibold tracking-[var(--tracking-snug)]">{title}</h2>
    <div className="flex flex-col gap-[var(--gap-inline)] text-body">{children}</div>
    {requestId === undefined && actions === undefined ? null : (
      <div className="flex flex-wrap items-center gap-[var(--gap-inline)]">
        {requestId === undefined ? null : <Data>request {requestId}</Data>}
        {actions}
      </div>
    )}
  </section>
)

/**
 * A failed load, rendered from whatever the query threw.
 *
 * The taxonomy is what decides the words: every failure from this API carries a code, and
 * `error-map.ts` is the one place that says what a person is told for each. Anything that is
 * NOT an `ApiError` never reached the API at all — offline, DNS, a proxy — and gets the one
 * honest sentence available for that.
 */
export const LoadFailed = ({
  what,
  error,
  onReload,
}: {
  /** The section that could not be loaded, for the eyebrow: "Traces". */
  what: string
  error: unknown
  onReload: () => void
}) => {
  const api = error instanceof ApiError ? error : null
  return (
    <Statement
      tone="fail"
      mark={<Mark tone="fail">failed</Mark>}
      eyebrow={what}
      title={api === null ? `${what} couldn’t be loaded` : api.treatment.title}
      requestId={api?.requestId}
      actions={
        <Button variant="outline" onClick={onReload}>
          Reload
        </Button>
      }
    >
      <p className="m-0">{api === null ? 'The API could not be reached.' : api.treatment.detail}</p>
      {/* Said explicitly because a failed READ looks identical to a failed write to someone
          who has just clicked something, and the difference is the only thing they need. */}
      <p className="m-0 text-muted-foreground">Nothing has been changed.</p>
    </Statement>
  )
}
