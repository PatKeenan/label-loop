import type { NameRule } from '@labelloop/contracts'
import { cn } from 'cn'
import { CheckIcon, XIcon } from 'lucide-react'

/**
 * A LIVE CHECKLIST under a field — each rule ✓ as it is met and ✕ as it is broken, the pattern
 * people know from password fields.
 *
 * **The rules are the server's.** They come from `@labelloop/contracts` (`names.ts`), the same
 * list the API validates with, so a field that shows all ✓ is a field the server accepts. A
 * checklist restated here would eventually promise something the server refuses.
 *
 * **Only the icon carries colour**; the label stays readable foreground or muted text. Colour is
 * the finding (rule 4 of the approved tokens), and a column of red sentences reads as a scolding
 * rather than a list of things to fix.
 */
export const RuleChecklist = ({
  rules,
  value,
  className,
}: {
  rules: readonly NameRule[]
  value: string
  className?: string
}) => {
  // Empty is PENDING, not failing: a form that opens covered in ✕ blames someone for not having
  // typed yet.
  const pending = value === ''
  return (
    <ul className={cn('m-0 flex list-none flex-col gap-[var(--gap-tight)] p-0', className)}>
      {rules.map((rule) => {
        const ok = !pending && rule.test(value)
        return (
          <li
            key={rule.id}
            className={cn(
              'flex items-center gap-[var(--gap-inline)] text-ui',
              pending || ok ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            <span aria-hidden className="grid size-4 shrink-0 place-items-center">
              {pending ? (
                <span className="size-1.5 rounded-full bg-foreground-faint" />
              ) : ok ? (
                <CheckIcon className="size-3.5 text-success" />
              ) : (
                <XIcon className="size-3.5 text-fail" />
              )}
            </span>
            {rule.label}
            <span className="sr-only">{pending ? '' : ok ? '(met)' : '(not met)'}</span>
          </li>
        )
      })}
    </ul>
  )
}

/** Whether every rule passes — the form's submit gate, from the same list the server uses. */
export const meetsRules = (rules: readonly NameRule[], value: string): boolean =>
  rules.every((rule) => rule.test(value))

/**
 * A labelled field whose rules show as soon as it has content, and stay — so nothing below it
 * moves when focus leaves (see the note at the checklist). An empty field shows them on focus.
 *
 * A server error that is one of the rule labels is not repeated: the ✕ beside that rule already
 * says it. Anything else the server reports — "that slug is taken" — shows beneath.
 */
export const RuledField = ({
  id,
  label,
  hint,
  rules,
  value,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  rules: readonly NameRule[]
  value: string
  error?: string | undefined
  children: React.ReactNode
}) => {
  const serverOnly = error !== undefined && !rules.some((rule) => rule.label === error)

  return (
    // `group` so the checklist can follow focus in CSS (`group-focus-within`) — no focus state
    // in React, and no handlers on a non-interactive element.
    <div className="group flex min-w-0 flex-col gap-[var(--gap-inline)]">
      <label htmlFor={id} className="text-ui font-medium">
        {label}
      </label>
      {children}
      {serverOnly ? (
        <span role="alert" className="text-ui text-fail">
          {error}
        </span>
      ) : hint !== undefined ? (
        <span className="text-ui text-muted-foreground">{hint}</span>
      ) : null}
      <RuleChecklist
        rules={rules}
        value={value}
        // Shown once the field has content, and KEPT — never collapsed on blur. The first
        // version tucked it away when focus left a valid field, and that moved everything below
        // it: pressing the submit button blurred the field, the list collapsed, the (centred)
        // form shifted, and the click landed where the button had been. The button looked dead.
        // Empty fields show it only on focus, so an untouched form still opens calm.
        className={value !== '' || error !== undefined ? '' : 'hidden group-focus-within:flex'}
      />
    </div>
  )
}
