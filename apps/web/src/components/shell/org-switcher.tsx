import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx'
import type { Membership } from './context.ts'
import { Data, Mark } from './mark.tsx'
import { useMenuFocusReturn } from './menu-focus.ts'

/**
 * The organisation, in the TOP BAR (ADR-0062 — it was at the foot of the sidebar under 6b
 * decision 5, and moved when the sidebar stopped existing outside a panel).
 *
 * **Plain text for one membership, a menu for several.** That is not a styling shortcut: the
 * common case is a person who belongs to one org and will never change it, and a control
 * that cannot do anything is worse than a label. Anyone with more than one gets the menu,
 * whatever their role.
 *
 * **The role is shown PER ORG, in the menu.** Switching to an org where this account is an
 * annotator changes the whole shell — the section nav goes, and the console becomes a
 * holding state — so the consequence is visible before the click rather than after it.
 *
 * Switching writes the org's SLUG into the URL and nothing else. There is no stored "active
 * org" anywhere: ADR-0047's reasoning is that a server-side or `localStorage` one lets a
 * second tab silently change what the first is showing.
 */
export const OrgSwitcher = ({
  memberships,
  activeOrgId,
}: {
  memberships: readonly Membership[]
  activeOrgId: string
}) => {
  const navigate = useNavigate()
  const { triggerProps, contentProps } = useMenuFocusReturn()
  const active = memberships.find((m) => m.org_id === activeOrgId)
  if (active === undefined) return null

  if (memberships.length === 1) {
    return (
      <div className="flex min-w-0 items-center gap-[var(--gap-tight)] px-[var(--pad-field-x)] text-muted-foreground">
        <Mark tone="neutral">{active.role}</Mark>
        <span className="truncate">{active.org_name}</span>
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        {...triggerProps}
        className={
          'flex min-h-[var(--row-min)] max-w-[20rem] items-center gap-[var(--gap-inline)] rounded-md ' +
          'border bg-secondary px-[var(--pad-field-x)] py-[var(--pad-field-y)] text-left ' +
          'hover:border-border-strong data-[state=open]:border-border-strong data-[state=open]:bg-muted'
        }
      >
        <Mark tone="neutral">{active.role}</Mark>
        <span className="min-w-0 flex-1 truncate">{active.org_name}</span>
        <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      {/* Opens DOWN from the bar, aligned to its right edge like the account menu beside it.
          (It opened upward while it lived at the foot of the rail, and kept doing so after
          ADR-0062 moved it — working only because Radix flips a menu that collides.) */}
      <DropdownMenuContent
        {...contentProps}
        side="bottom"
        align="end"
        className="min-w-(--radix-dropdown-menu-trigger-width)"
      >
        {memberships.map((membership) => (
          <DropdownMenuItem
            key={membership.org_id}
            // Switching an org invalidates the whole view, so it goes to Home rather than
            // carrying the current panel across: a panel slug is scoped to ONE org, and
            // keeping it would ask for a panel this org does not have — which is a
            // not-found state produced by the console rather than by the person.
            onSelect={() => void navigate({ to: '/', search: { org: membership.org_slug } })}
            className="flex min-h-[var(--row-min)] items-center gap-[var(--gap-inline)]"
          >
            <span className="flex min-w-0 flex-col">
              <strong className="truncate font-semibold">{membership.org_name}</strong>
              <Data className="truncate">{membership.org_slug}</Data>
            </span>
            <Mark tone="neutral" className="ml-auto">
              {membership.role}
            </Mark>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
