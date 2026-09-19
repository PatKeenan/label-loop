import {
  can,
  GRANTABLE_ROLES,
  type GrantableRole,
  invitationEmailSchema,
  ROLE_DESCRIPTIONS,
} from '@labelloop/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../api/client.ts'
import { membersQuery } from '../api/queries.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { Data, Eyebrow, Mark } from '../components/shell/mark.tsx'
import { PageHead } from '../components/shell/page-head.tsx'
import { LoadFailed, Statement } from '../components/shell/statement.tsx'
import { Button } from '../components/ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog.tsx'
import { Input } from '../components/ui/input.tsx'
import { ApiError, apiErrorFrom } from '../errors/api-error.ts'

/**
 * ORGANISATION SETTINGS → MEMBERS (ADR-0065, ADR-0070): invite by email and role, change a
 * role, remove a member, revoke an invitation. Admin-only — `member: [manage]`, which the
 * server enforces on every write; this screen mirrors it and replaces nothing.
 *
 * Nothing is emailed (no email provider — a stack decision not taken). The invited person signs
 * in with that address, verified, and lands in the org on their first page load.
 */
export const MembersPage = () => {
  const context = useConsoleContext()
  const queryClient = useQueryClient()
  const ready = context.state === 'ready'
  const orgId = ready ? context.orgId : ''
  const manages = ready && can(context.role, { member: ['manage'] })
  const members = useQuery({ ...membersQuery(orgId), enabled: manages })

  const [email, setEmail] = useState('')
  const [role, setRole] = useState<GrantableRole>('annotator')
  const [emailError, setEmailError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<{ userId: string; email: string } | null>(null)

  const asOrg = { headers: { 'X-LabelLoop-Org': orgId } }
  // `/me` too: a change to your OWN role changes what the console may offer you.
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['members', orgId] }),
      queryClient.invalidateQueries({ queryKey: ['me'] }),
    ])

  const invite = useMutation({
    mutationFn: async () => {
      const response = await api.internal.invitations.$post({ json: { email, role } }, asOrg)
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async () => {
      setEmail('')
      setEmailError(null)
      await refresh()
    },
    onError: (error) => {
      // ERROR SURFACE 1 where the server located it: beside the field.
      const onField =
        error instanceof ApiError ? error.issues.find((i) => i.path === 'email') : undefined
      if (onField !== undefined) setEmailError(onField.message)
      else
        toast.error('Couldn’t invite', { description: describe(error, 'No invitation was made.') })
    },
  })

  const changeRole = useMutation({
    mutationFn: async ({ userId, next }: { userId: string; next: GrantableRole }) => {
      const response = await api.internal.members[':userId'].$patch(
        { param: { userId }, json: { role: next } },
        asOrg,
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error('Couldn’t change the role', {
        description: describe(error, 'The role is unchanged.'),
      }),
  })

  const remove = useMutation({
    mutationFn: async (userId: string) => {
      const response = await api.internal.members[':userId'].$delete({ param: { userId } }, asOrg)
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async () => {
      setRemoving(null)
      await refresh()
    },
    onError: (error) => {
      setRemoving(null)
      toast.error('Couldn’t remove the member', {
        description: describe(error, 'They are still a member.'),
      })
    },
  })

  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const response = await api.internal.invitations[':id'].$delete({ param: { id } }, asOrg)
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: refresh,
    onError: (error) =>
      toast.error('Couldn’t revoke the invitation', {
        description: describe(error, 'It can still be claimed.'),
      }),
  })

  if (!ready) return null

  const head = <PageHead scope={[context.orgSlug]} title="Members" />

  if (!manages) {
    return (
      <>
        {head}
        <Statement eyebrow="Not available" title="Only an admin can manage members">
          <p className="m-0">
            Your role in {context.orgName} is {context.role.replace('_', ' ')}.
          </p>
        </Statement>
      </>
    )
  }

  const emailValid = invitationEmailSchema.safeParse(email).success

  return (
    <>
      {head}

      <section className="flex max-w-[var(--measure)] flex-col gap-[var(--gap-stack)]">
        <h2 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">Invite</h2>
        <form
          className="flex flex-wrap items-start gap-[var(--gap-inline)]"
          onSubmit={(event) => {
            event.preventDefault()
            invite.mutate()
          }}
        >
          <div className="flex min-w-[16rem] flex-1 flex-col gap-[var(--gap-tight)]">
            <Input
              type="email"
              aria-label="Email"
              placeholder="name@example.com"
              value={email}
              aria-invalid={emailError !== null}
              onChange={(event) => {
                setEmail(event.target.value)
                setEmailError(null)
              }}
              required
            />
            {emailError === null ? null : <p className="m-0 text-ui text-fail">{emailError}</p>}
          </div>
          <RoleSelect label="Role" value={role} onChange={setRole} />
          <Button type="submit" disabled={!emailValid || invite.isPending}>
            {invite.isPending ? 'Inviting…' : 'Invite'}
          </Button>
        </form>
        <p className="m-0 text-ui text-muted-foreground">
          {ROLE_DESCRIPTIONS[role]} Nothing is emailed — they join when they sign in with this
          address.
        </p>
      </section>

      {members.isPending ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : members.error !== null ? (
        <LoadFailed
          what="Members"
          error={members.error}
          onReload={() => void queryClient.invalidateQueries({ queryKey: ['members', orgId] })}
        />
      ) : (
        <>
          <Table columns={['Member', 'Role', 'Joined', '']}>
            {members.data.members.map((member) => (
              <tr key={member.user_id} className="border-b border-border-soft">
                <Cell>
                  {member.email}
                  {member.email === context.email ? (
                    <Mark tone="neutral" className="ml-[var(--gap-inline)]">
                      you
                    </Mark>
                  ) : null}
                </Cell>
                <Cell>
                  {isGrantable(member.role) ? (
                    <RoleSelect
                      label={`Role for ${member.email}`}
                      value={member.role}
                      disabled={changeRole.isPending}
                      onChange={(next) => changeRole.mutate({ userId: member.user_id, next })}
                    />
                  ) : (
                    <Mark tone="neutral">{member.role.replace('_', ' ')}</Mark>
                  )}
                </Cell>
                <Cell>
                  <Data>{member.joined_at.slice(0, 10)}</Data>
                </Cell>
                <Cell className="text-right">
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-fail-line text-fail hover:bg-fail-tint"
                    onClick={() => setRemoving({ userId: member.user_id, email: member.email })}
                  >
                    Remove
                  </Button>
                </Cell>
              </tr>
            ))}
          </Table>

          {members.data.invitations.length === 0 ? null : (
            <section className="flex flex-col gap-[var(--gap-stack)]">
              <h2 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">
                Waiting to sign in
              </h2>
              <Table columns={['Email', 'Role', 'Expires', '']}>
                {members.data.invitations.map((invitation) => (
                  <tr key={invitation.id} className="border-b border-border-soft">
                    <Cell>{invitation.email}</Cell>
                    <Cell>
                      <Mark tone="neutral">{invitation.role.replace('_', ' ')}</Mark>
                    </Cell>
                    <Cell>
                      <Data>{invitation.expires_at.slice(0, 10)}</Data>
                    </Cell>
                    <Cell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(invitation.id)}
                      >
                        Revoke
                      </Button>
                    </Cell>
                  </tr>
                ))}
              </Table>
            </section>
          )}
        </>
      )}

      {/*
        Removal confirms; not removing is the safe outcome, so Escape, the backdrop and Cancel
        all dismiss. The fail colour is OUTLINED, as on revoking a key (6b decision 11).
      */}
      <Dialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <Eyebrow>Remove member</Eyebrow>
            <DialogTitle>Remove {removing?.email}?</DialogTitle>
            <DialogDescription>
              They lose access to {context.orgName} immediately. Anything they created or annotated
              stays, attributed to them. To bring them back, invite them again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="border-fail-line text-fail hover:bg-fail-tint"
              disabled={remove.isPending}
              onClick={() => removing !== null && remove.mutate(removing.userId)}
            >
              {remove.isPending ? 'Removing…' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

const isGrantable = (role: string): role is GrantableRole =>
  (GRANTABLE_ROLES as readonly string[]).includes(role)

/**
 * A native select, styled as the inputs are. Native rather than a menu: three options, and the
 * keyboard, screen-reader and mobile behaviour of a `<select>` come for free.
 */
const RoleSelect = ({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string
  value: GrantableRole
  onChange: (role: GrantableRole) => void
  disabled?: boolean
}) => (
  <select
    aria-label={label}
    value={value}
    disabled={disabled}
    onChange={(event) => {
      const next = event.target.value
      if (isGrantable(next)) onChange(next)
    }}
    className="h-9 rounded-md border border-input bg-background px-[var(--pad-field-x)] text-ui text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
  >
    {GRANTABLE_ROLES.map((option) => (
      <option key={option} value={option}>
        {option}
      </option>
    ))}
  </select>
)

const Table = ({
  columns,
  children,
}: {
  columns: readonly string[]
  children: React.ReactNode
}) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse text-data">
      <thead>
        <tr className="border-b border-border-strong text-left">
          {columns.map((column) => (
            <th
              key={column}
              className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
            >
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
)

const Cell = ({ className, ...props }: React.ComponentProps<'td'>) => (
  <td className={cn('px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]', className)} {...props} />
)

/** What a failed ACTION says: the taxonomy's words, then the state the action left behind. */
const describe = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? `${error.message} ${fallback}${error.requestId === undefined ? '' : ` · request ${error.requestId}`}`
    : fallback
