import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { auth } from '../../api/client.ts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.tsx'
import { forgetIssuedKeys } from './issued-key.ts'
import { Data } from './mark.tsx'
import { useMenuFocusReturn } from './menu-focus.ts'

/**
 * THE ACCOUNT MENU — the address you are signed in as, and the way out.
 *
 * **One component for both surfaces** (M5 phase 5). It lived inside the console shell until the
 * annotator surface shipped with a static email chip beside it and no way to sign out at all:
 * the way out of an application is not a console feature, and two implementations of signing
 * out is one of them being forgotten. The console passes its own items (Organisation settings);
 * everything else — the cache clear, the one-time key plaintext, the order of the two — belongs
 * to signing out rather than to either surface.
 *
 * `useMenuFocusReturn` is required on the trigger and content: without it focus is lost to the
 * body when the menu closes, and the next Tab starts from the top of the document.
 */
export const AccountMenu = ({
  email,
  items,
}: {
  email: string
  /** Rendered above a separator, before Sign out. The console's settings link, or nothing. */
  items?: React.ReactNode
}) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { triggerProps, contentProps } = useMenuFocusReturn()

  const signOut = useMutation({
    mutationFn: async () => {
      await auth.signOut()
    },
    onSuccess: async () => {
      // The one-time key plaintext lives outside the query cache, so nothing below reaches
      // it. A credential minted as one account must not survive into the next.
      forgetIssuedKeys()
      // Everything in the cache was read as this user, so none of it may be shown again.
      // `clear` BEFORE navigating, and it is the order that matters: `/login`'s `beforeLoad`
      // asks who is signed in, and a cache still holding this user would answer "you are"
      // and bounce straight back. `clear` notifies no observer, so the screen does not
      // re-render as signed out in the meantime — which would send it to `/login` with THIS
      // page as the redirect, when signing out is a request to leave, not to come back.
      queryClient.clear()
      await navigate({ to: '/login', replace: true })
    },
  })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        {...triggerProps}
        aria-label="Account"
        className="flex min-h-[var(--row-min)] items-center gap-[var(--gap-tight)] rounded-md border bg-secondary px-[var(--pad-field-x)] hover:border-border-strong"
      >
        <Data className="max-w-[16rem] truncate text-foreground">{email}</Data>
      </DropdownMenuTrigger>
      <DropdownMenuContent {...contentProps} align="end">
        {items === undefined ? null : (
          <>
            {items}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem
          onSelect={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="min-h-[var(--row-min)]"
        >
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
