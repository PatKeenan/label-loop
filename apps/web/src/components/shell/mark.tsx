import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from 'cn'

/**
 * A state MARK — square-cornered, outlined, tinted. Borrowed from the Ledger direction and
 * named in `tokens.css`'s thesis: classification and judge states render as marks, not as
 * soft pills, because a pill reads as decoration and this is data.
 *
 * The five tones are the five the approved palette defines, and they are not
 * interchangeable: `success` is agreement or a passing eval, `fail` is disagreement or a
 * regression or revoked access, `warning` is low confidence or a honeypot or drift,
 * `info` is judge-generated or system metadata, `neutral` is unannotated or not-yet-run.
 * Reach for the one that answers the question the reader has, not the one that looks right.
 *
 * `--radius-mark` is `--radius-xs` at EVERY density, which is why this is the one component
 * that does not use `rounded-md`: a mark stays square when the console tightens up.
 */
const markVariants = cva(
  'inline-flex items-center whitespace-nowrap border font-mono uppercase text-micro ' +
    'leading-[var(--leading-flat)] tracking-[var(--tracking-wide)] ' +
    'rounded-[var(--radius-mark)] px-[var(--pad-mark-x)] py-[var(--pad-mark-y)]',
  {
    variants: {
      tone: {
        success: 'text-success bg-success-tint border-success-line',
        fail: 'text-fail bg-fail-tint border-fail-line',
        warning: 'text-warning bg-warning-tint border-warning-line',
        info: 'text-info bg-info-tint border-info-line',
        neutral: 'text-neutral bg-neutral-tint border-neutral-line',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type MarkProps = React.ComponentProps<'span'> & VariantProps<typeof markVariants>

export const Mark = ({ className, tone, ...props }: MarkProps) => (
  <span className={cn(markVariants({ tone }), className)} {...props} />
)

/**
 * The uppercase mono eyebrow: column heads, and the label above a title. `--tracking-micro`
 * exists for exactly this and nothing else, which is why it is spelled out here rather than
 * registered as a utility.
 */
export const Eyebrow = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span
    className={cn(
      'font-mono text-micro uppercase tracking-[var(--tracking-micro)] text-muted-foreground',
      className,
    )}
    {...props}
  />
)

/**
 * Mono and achromatic: ids, money, counts, latencies, token counts. Rule 4 of the approved
 * tokens — numbers earn colour only when the colour IS the finding.
 */
export const Data = ({ className, ...props }: React.ComponentProps<'span'>) => (
  <span className={cn('font-mono text-data text-muted-foreground', className)} {...props} />
)
