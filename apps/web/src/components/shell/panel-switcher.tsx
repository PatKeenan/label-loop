import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { ChevronDownIcon } from 'lucide-react'
import { panelsQuery } from '../../api/queries.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx'
import { Data, Eyebrow } from './mark.tsx'

/**
 * The panel switcher — and, deliberately, THE PANELS SECTION (6b decision 3).
 *
 * There is no "Panels" nav item and no "All panels" entry, because Home IS the list and
 * every section below this control belongs to the one panel named in it. That rule is what
 * lets the sidebar read as one thing instead of two stacked navigations
 * (CONSOLE_FLOW §4, R2).
 *
 * At Home it reads "Choose a panel" with the count beside it; inside a panel it names that
 * panel. Its menu is every panel in the org, then Create panel.
 */
export const PanelSwitcher = ({
  orgId,
  orgSlug,
  activePanelSlug,
}: {
  orgId: string
  orgSlug: string
  activePanelSlug: string | null
}) => {
  const navigate = useNavigate()
  const panels = useQuery(panelsQuery(orgId))
  const active = panels.data?.find((panel) => panel.slug === activePanelSlug) ?? null

  // The org travels with every link, so a switched org survives every navigation from here.
  const search = { org: orgSlug }

  return (
    <div className="flex flex-col gap-[var(--gap-tight)]">
      <Eyebrow className="px-[var(--pad-field-x)]">Panel</Eyebrow>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={
            'flex min-h-[var(--row-min)] w-full items-center gap-[var(--gap-inline)] rounded-md ' +
            'border bg-secondary px-[var(--pad-field-x)] py-[var(--pad-field-y)] text-left ' +
            'hover:border-border-strong data-[state=open]:border-border-strong data-[state=open]:bg-muted'
          }
        >
          <span className="flex min-w-0 flex-1 flex-col">
            {active === null ? (
              <>
                <strong className="truncate font-semibold text-muted-foreground">
                  Choose a panel
                </strong>
                <Data className="truncate">
                  {panels.isPending
                    ? '…'
                    : `${panels.data?.length ?? 0} ${panels.data?.length === 1 ? 'panel' : 'panels'}`}
                </Data>
              </>
            ) : (
              <>
                <strong className="truncate font-semibold">{active.name}</strong>
                <Data className="truncate">{active.slug}</Data>
              </>
            )}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-(--radix-dropdown-menu-trigger-width)">
          {panels.data?.map((panel) => (
            <DropdownMenuItem
              key={panel.id}
              // A panel opens on its Overview — its home, and at M4 its onboarding
              // (6b decision 4, ADR-0060 as amended to M4).
              onSelect={() =>
                void navigate({ to: '/p/$panelSlug', params: { panelSlug: panel.slug }, search })
              }
              className="flex min-h-[var(--row-min)] flex-col items-start gap-0"
            >
              <strong className="truncate font-semibold">{panel.name}</strong>
              <Data className="truncate">{panel.slug}</Data>
            </DropdownMenuItem>
          ))}
          {panels.data === undefined || panels.data.length === 0 ? null : <DropdownMenuSeparator />}
          <DropdownMenuItem
            // Phase 8 builds the screen; the entry point is shell furniture and exists now
            // so the switcher is not re-invented when it arrives.
            disabled
            className="flex min-h-[var(--row-min)] items-center"
          >
            <strong className="font-semibold">Create panel</strong>
            <Data className="ml-auto">phase 8</Data>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
