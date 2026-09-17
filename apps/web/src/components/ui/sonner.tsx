import { Toaster as Sonner, type ToasterProps } from 'sonner'

/**
 * Sonner, wired to our tokens. shadcn's copy of this file was rewritten rather than tweaked,
 * because two of its assumptions are wrong here and both fail silently.
 *
 * **It imported `next-themes`.** There is no Next.js in this repo and no theme provider: the
 * approved tokens declare tone through `data-tone` / `data-surface` attributes (ADR-0046),
 * which is CSS, not React state. The import is gone and `theme` is pinned to `light` — not a
 * claim about how this looks, but the value that makes Sonner add no palette of its own, so
 * the four variables below are the only thing deciding it.
 *
 * **It read `var(--popover)`, `var(--popover-foreground)` and `var(--border)` directly.**
 * Those are shadcn RUNTIME variables, and our conversion has none. `tokens.css` §6 aliases
 * shadcn's names for utility GENERATION only — `@theme inline` declares nothing — so
 * `bg-popover` works and a raw `var(--popover)` resolves to nothing at all. Read directly it
 * would have produced an unstyled toast with no error anywhere. They point at our tokens
 * instead, which is also what makes the toast follow the tone.
 *
 * `--border-radius` keeps `var(--radius)`, which IS declared for real — the one runtime
 * property the conversion adds, precisely so components that read it this way still work.
 *
 * **`duration: Infinity` is a product decision, not a default** (CONSOLE_FLOW §6). This
 * surface exists for an ACTION that failed: it says what state the action left behind
 * ("still active"), and carries the request id someone would quote. A toast that dismisses
 * itself takes that away on a timer from a person who was reading it. Dismissal is explicit,
 * which is why `closeButton` is on. A caller that genuinely wants a transient toast passes
 * its own `duration` at the call site.
 */
export const Toaster = ({ ...props }: ToasterProps) => (
  <Sonner
    theme="light"
    className="toaster group"
    position="bottom-right"
    closeButton
    toastOptions={{ duration: Number.POSITIVE_INFINITY }}
    style={
      {
        '--normal-bg': 'var(--color-surface)',
        '--normal-text': 'var(--color-text)',
        '--normal-border': 'var(--color-line-strong)',
        '--border-radius': 'var(--radius)',
      } as React.CSSProperties
    }
    {...props}
  />
)
