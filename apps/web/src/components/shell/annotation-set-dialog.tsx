import {
  ANNOTATION_SET_MAX_SIZE,
  DISPLAY_NAME_RULES,
  type SizedAnnotationSetStrategy,
} from '@labelloop/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'
import { api } from '../../api/client.ts'
import { ApiError, apiErrorFrom } from '../../errors/api-error.ts'
import { Button } from '../ui/button.tsx'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.tsx'
import { Input } from '../ui/input.tsx'
import { Data, Eyebrow } from './mark.tsx'
import { meetsRules, RuledField } from './rule-checklist.tsx'

/**
 * NEW ANNOTATION SET — one step, a dialog, the same posture as Create panel (ADR-0062).
 *
 * **Two ways in, one dialog.** The Annotations section opens it with a picker to choose; the
 * trace table opens it with rows already selected, where the picker IS the selection and there
 * is nothing to choose. The second form has no strategy control at all rather than a disabled
 * one — a control that cannot be used is a question the reader has to answer before ignoring.
 *
 * **The count it will take is shown before it runs** (plan, phase 4). A picker is resolved once
 * and written down (ADR-0080), so "25 of 82" is a claim about what the set will hold, and a
 * person about to make one should not have to guess at it.
 */
export const CreateAnnotationSetDialog = ({
  open,
  onClose,
  orgId,
  orgSlug,
  panelSlug,
  panelTraceCount,
  traceIds,
}: {
  open: boolean
  onClose: () => void
  orgId: string
  orgSlug: string
  panelSlug: string
  panelTraceCount: number
  /** When present, the set is these traces and nothing else — `manual`, from the trace table. */
  traceIds?: readonly string[]
}) => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [strategy, setStrategy] = useState<SizedAnnotationSetStrategy>('random_n')
  const [size, setSize] = useState(25)
  const [nameError, setNameError] = useState<string | undefined>(undefined)

  const manual = traceIds !== undefined
  const asked = manual ? traceIds.length : size
  // What the picker can actually reach. A set cannot hold more traces than the panel has, and
  // saying "25 of 12" would be the dialog promising something the server will not do.
  const willTake = manual ? asked : Math.min(asked, panelTraceCount, ANNOTATION_SET_MAX_SIZE)

  const create = useMutation({
    mutationFn: async () => {
      const body = manual
        ? { name, strategy: 'manual' as const, trace_ids: [...traceIds] }
        : { name, strategy, size }
      const response = await api.internal.panels[':slug']['annotation-sets'].$post(
        { param: { slug: panelSlug }, json: body },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async (data) => {
      await queryClient.invalidateQueries({ queryKey: ['annotation-sets', orgId, panelSlug] })
      close()
      toast.success(`“${name}” holds ${data.size} ${data.size === 1 ? 'trace' : 'traces'}.`)
      // Straight into the set: the next thing anybody does with a new set is assign it.
      await navigate({
        to: '/p/$panelSlug/annotations/$setId',
        params: { panelSlug, setId: data.id },
        search: { org: orgSlug },
      })
    },
    onError: (error: unknown) => {
      if (error instanceof ApiError) {
        const issue = error.issues.find((candidate) => candidate.path === 'name')
        if (issue !== undefined) {
          setNameError(issue.message)
          return
        }
      }
      toast.error('That couldn’t be created. Nothing was changed.')
    },
  })

  const close = () => {
    setName('')
    setNameError(undefined)
    setSize(25)
    setStrategy('random_n')
    create.reset()
    onClose()
  }

  const valid =
    meetsRules(DISPLAY_NAME_RULES, name) && willTake >= 1 && asked <= ANNOTATION_SET_MAX_SIZE

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[34rem]">
        <DialogHeader className="gap-[var(--gap-inline)] px-[var(--space-8)] pt-[var(--space-8)] pb-[var(--space-6)]">
          <Eyebrow>{panelSlug}</Eyebrow>
          <DialogTitle className="text-title font-semibold leading-[var(--leading-title)] tracking-[var(--tracking-snug)]">
            New annotation set
          </DialogTitle>
          <DialogDescription>
            {manual
              ? 'The traces you selected, snapshotted. Assign annotators next.'
              : 'A snapshot of this panel’s traces. Assign annotators next.'}
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <div className="flex flex-col gap-[var(--space-6)] px-[var(--space-8)] pb-[var(--space-8)]">
            <RuledField
              id="set-name"
              label="Name"
              rules={DISPLAY_NAME_RULES}
              value={name}
              error={nameError}
            >
              <Input
                id="set-name"
                value={name}
                placeholder="Refund replies, week 1"
                onChange={(event) => {
                  setName(event.target.value)
                  setNameError(undefined)
                }}
                aria-invalid={nameError !== undefined}
                required
              />
            </RuledField>

            {manual ? null : (
              <div className="flex flex-wrap items-end gap-[var(--gap-inline)]">
                <div className="flex min-w-[10rem] flex-1 flex-col gap-[var(--gap-inline)]">
                  <label htmlFor="set-strategy" className="text-ui font-medium">
                    Pick
                  </label>
                  {/*
                    Native, as the role select is: three options, and the keyboard, screen-reader
                    and mobile behaviour come for free.
                  */}
                  <select
                    id="set-strategy"
                    value={strategy}
                    onChange={(event) =>
                      setStrategy(event.target.value as SizedAnnotationSetStrategy)
                    }
                    className="h-9 rounded-md border border-input bg-background px-[var(--pad-field-x)] text-ui text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <option value="random_n">At random</option>
                    <option value="latest_n">Most recent</option>
                    <option value="earliest_n">Oldest first</option>
                  </select>
                </div>
                <div className="flex w-[7rem] flex-col gap-[var(--gap-inline)]">
                  <label htmlFor="set-size" className="text-ui font-medium">
                    How many
                  </label>
                  <Input
                    id="set-size"
                    type="number"
                    min={1}
                    max={ANNOTATION_SET_MAX_SIZE}
                    value={size}
                    onChange={(event) => setSize(Number(event.target.value))}
                  />
                </div>
              </div>
            )}

            {/*
              WHAT IT WILL TAKE, before it runs. The picker resolves once and is written down,
              so this is the set's size rather than a guess — and if the panel has fewer traces
              than were asked for, saying so here beats a set that quietly holds less.
            */}
            <p className="m-0 text-ui text-muted-foreground">
              Takes <Data className="text-foreground">{willTake}</Data>
              {manual
                ? ` selected ${willTake === 1 ? 'trace' : 'traces'}.`
                : ` of ${panelTraceCount} ${panelTraceCount === 1 ? 'trace' : 'traces'}.`}{' '}
              {!manual && willTake < asked
                ? 'That is everything this panel has collected so far.'
                : `A set holds at most ${ANNOTATION_SET_MAX_SIZE}; top it up later.`}
            </p>
          </div>

          <DialogFooter className="px-[var(--space-8)] pb-[var(--space-8)]">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || create.isPending}>
              {create.isPending ? 'Creating…' : 'Create set'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
