import { DISPLAY_NAME_RULES } from '@labelloop/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { cn } from 'cn'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../api/client.ts'
import { keysQuery } from '../api/queries.ts'
import { useConsoleContext, usePanelContext } from '../components/shell/context.ts'
import { issuedKeyFor, rememberIssuedKey } from '../components/shell/issued-key.ts'
import { Data, Eyebrow, Mark } from '../components/shell/mark.tsx'
import { PageHead, panelTrail } from '../components/shell/page-head.tsx'
import { meetsRules, RuleChecklist } from '../components/shell/rule-checklist.tsx'
import { Snippet } from '../components/shell/snippet.tsx'
import { LoadFailed } from '../components/shell/statement.tsx'
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
 * KEYS — issue, list, revoke, for ONE panel.
 *
 * Every key is scoped to a panel (ADR-0003), which is why this lives in the panel's section
 * nav rather than at the org level: a key that could evaluate anything would make "what does
 * Client A owe for this panel" unanswerable, and metering runs org → panel → judge → key.
 *
 * **The two modals have opposite temperaments, and that is decision 10 of the 6b shell.**
 * The reveal has no close button and cannot be dismissed by Escape or the backdrop, because
 * dismissing it destroys the only copy of a live credential. The revoke confirmation dismisses
 * on all three, because NOT revoking is the safe outcome.
 */
export const PanelKeysPage = () => {
  const context = useConsoleContext()
  const panel = usePanelContext(context.state === 'ready' ? context.orgId : null)
  const queryClient = useQueryClient()

  const orgId = context.state === 'ready' ? context.orgId : ''
  const keys = useQuery({ ...keysQuery(orgId), enabled: context.state === 'ready' })

  const [name, setName] = useState('')
  const [revealed, setRevealed] = useState<{ name: string; plaintext: string } | null>(null)
  const [revoking, setRevoking] = useState<{ id: string; name: string; last4: string } | null>(null)

  const panelId = panel.state === 'ready' ? panel.id : ''

  const issue = useMutation({
    mutationFn: async () => {
      const response = await api.internal.keys.$post(
        { json: { panel_id: panelId, name: name.trim() } },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async (data) => {
      // `data.key` is the plaintext, and `shown_once: true` on the response is the server
      // saying what this is. The NAME comes from the form rather than the response, which
      // does not echo it — this is the only moment both halves exist together.
      const issuedName = name.trim()
      setName('')
      setRevealed({ name: issuedName, plaintext: data.key })
      /**
       * Hand it to the panel's Overview as well, for this tab's lifetime.
       *
       * The snippet there is only RUNNABLE while a real key is in hand, and the plaintext
       * exists exactly once — so a panel whose creation reveal has been left behind shows
       * `YOUR_KEY` and nothing can change that. Issuing a key here is the one other moment a
       * plaintext exists, and it would be strange to hold it in a modal and still send someone
       * to a snippet that cannot run. Same in-memory store, same lifetime: gone on reload.
       */
      rememberIssuedKey(panelId, data.key)
      await queryClient.invalidateQueries({ queryKey: ['keys', orgId] })
    },
    onError: (error) => {
      // ERROR SURFACE 3: an ACTION failed. It never dismisses itself and it names what state
      // the action left behind, because that is the only thing the person needs next.
      toast.error('Couldn’t issue a key', {
        description: describe(error, 'No key was created.'),
      })
    },
  })

  const revoke = useMutation({
    mutationFn: async (keyId: string) => {
      const response = await api.internal.keys[':key_id'].revoke.$post(
        { param: { key_id: keyId } },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async () => {
      setRevoking(null)
      await queryClient.invalidateQueries({ queryKey: ['keys', orgId] })
    },
    onError: (error, keyId) => {
      const failed = revoking
      setRevoking(null)
      toast.error(`Couldn’t revoke ${failed?.name ?? keyId}`, {
        // The state the action left behind. A person who clicked revoke and saw a failure
        // needs to know whether the key still works — and it does.
        description: describe(
          error,
          'The key is unchanged and still active — calls using it are still accepted.',
        ),
      })
    },
  })

  if (context.state !== 'ready' || panel.state !== 'ready') return null

  const head = (
    <PageHead
      scope={panelTrail(context.orgSlug, panel.slug)}
      title="Keys"
      actions={
        <form
          className="flex items-center gap-[var(--gap-inline)]"
          onSubmit={(event) => {
            event.preventDefault()
            issue.mutate()
          }}
        >
          {/*
            The shared name rules, as a checklist that floats under the input while it has focus
            or a rule is broken — inline in the page head there is no room for it to push the
            layout down. Same rules the server validates `name` with.
          */}
          <div className="group relative">
            <Input
              aria-label="Key name"
              placeholder="What will use it"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-[14rem]"
              required
            />
            <RuleChecklist
              rules={DISPLAY_NAME_RULES}
              value={name}
              className={cn(
                'absolute top-full right-0 z-10 mt-[var(--gap-tight)] w-max rounded-md border bg-popover px-[var(--pad-field-x)] py-[var(--pad-field-y)] shadow-md',
                name !== '' && !meetsRules(DISPLAY_NAME_RULES, name)
                  ? ''
                  : 'hidden group-focus-within:flex',
              )}
            />
          </div>
          <Button type="submit" disabled={!meetsRules(DISPLAY_NAME_RULES, name) || issue.isPending}>
            {issue.isPending ? 'Issuing…' : 'Issue key'}
          </Button>
        </form>
      }
    />
  )

  if (keys.isPending) {
    return (
      <>
        {head}
        <p className="text-muted-foreground">Loading…</p>
      </>
    )
  }
  if (keys.error !== null) {
    return (
      <>
        {head}
        <LoadFailed
          what="Keys"
          error={keys.error}
          onReload={() => void queryClient.invalidateQueries({ queryKey: ['keys', orgId] })}
        />
      </>
    )
  }

  // `GET /internal/keys` is org-wide; this screen is about ONE panel. Filtering here is safe
  // where the same move on traces would not be — a key list is bounded by how many
  // credentials an org has issued, so there is no page for a filter to silently drop rows off.
  const mine = keys.data.filter((key) => key.panel_id === panel.id)

  return (
    <>
      {head}

      {mine.length === 0 ? (
        <p className="text-muted-foreground">
          No keys for this panel. The one it was created with may have been revoked — issue another
          above.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-data">
            <thead>
              <tr className="border-b border-border-strong text-left">
                {['Name', 'Key', 'Status', 'Created', ''].map((column) => (
                  <th
                    key={column}
                    className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] font-mono text-micro font-normal uppercase tracking-[var(--tracking-micro)] text-muted-foreground"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {mine.map((key) => (
                <tr key={key.id} className="border-b border-border-soft">
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">{key.name}</td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    {/* The last four only. The plaintext existed once; the hash is not shown
                        either, because a list endpoint is not where a lookup value belongs. */}
                    <Data>…{key.last4}</Data>
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    <Mark tone={key.status === 'active' ? 'success' : 'fail'}>{key.status}</Mark>
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)]">
                    <Data>{key.created_at}</Data>
                  </td>
                  <td className="px-[var(--pad-cell-x)] py-[var(--pad-cell-y)] text-right">
                    {key.status === 'active' ? (
                      <Button
                        variant="outline"
                        size="sm"
                        className="border-fail-line text-fail hover:bg-fail-tint"
                        onClick={() =>
                          setRevoking({ id: key.id, name: key.name, last4: key.last4 })
                        }
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/*
        The integration snippet's standing home once a panel has traffic (Deviation 65). A
        key issued above feeds it for this tab — the one other moment a plaintext exists.
      */}
      <Snippet panelId={panel.id} apiKey={issuedKeyFor(panel.id)} variant="reference" />

      {/*
        THE REVEAL. No close button, and Escape and the backdrop do nothing — dismissing it
        destroys the only copy (6b decision 10). The one exit is explicit.
      */}
      <Dialog open={revealed !== null}>
        <DialogContent
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <Eyebrow>Key issued</Eyebrow>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>
              LabelLoop keeps only a hash of this key. Once this closes, the full key can’t be shown
              again — to you or anyone. If it’s lost, revoke it and issue another.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted px-[var(--pad-field-x)] py-[var(--pad-field-y)] font-mono text-data break-all select-all">
            {revealed?.plaintext}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                if (revealed !== null) void navigator.clipboard.writeText(revealed.plaintext)
              }}
            >
              Copy
            </Button>
            <Button onClick={() => setRevealed(null)}>I’ve copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        THE REVOKE CONFIRMATION. Escape, the backdrop and Cancel all dismiss, because not
        revoking is the safe outcome. The destructive action is OUTLINED in the fail state
        rather than filled — "revoked access" is what that colour means (6b decision 11).
      */}
      <Dialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <Eyebrow>Revoke key</Eyebrow>
            <DialogTitle>Revoke {revoking?.name}?</DialogTitle>
            <DialogDescription>
              Calls using the key ending <Data>{revoking?.last4}</Data> are refused from the moment
              you confirm. The key stays in the list, marked revoked, and its history stays in the
              audit log. This can’t be undone — a replacement is a new key.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevoking(null)}>
              Cancel
            </Button>
            <Button
              variant="outline"
              className="border-fail-line text-fail hover:bg-fail-tint"
              disabled={revoke.isPending}
              onClick={() => revoking !== null && revoke.mutate(revoking.id)}
            >
              {revoke.isPending ? 'Revoking…' : 'Revoke key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/**
 * What a failed ACTION says. The taxonomy decides the words where it can; `fallback` is what
 * the person needs regardless, which is the state the action left behind.
 */
const describe = (error: unknown, fallback: string): string =>
  error instanceof ApiError
    ? `${error.treatment.detail} ${fallback}${error.requestId === undefined ? '' : ` · request ${error.requestId}`}`
    : fallback
