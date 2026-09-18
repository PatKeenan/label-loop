import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
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
import { useConsoleContext } from './context.ts'
import { rememberIssuedKey } from './issued-key.ts'
import { Data, Eyebrow } from './mark.tsx'

/**
 * CREATING A PANEL IS ONE STEP, AND IT IS A DIALOG (6c decision 1, ADR-0061; ADR-0062).
 *
 * **There was a four-step wizard here, and its own review deleted it.** Panel details →
 * judges → model picker → review was the plan's shape; r3 of the mockup cut it to one step,
 * because judges cannot be authored before error analysis, so a wizard that collects them is
 * collecting guesses the product's own loop exists to replace. The model picker moved to M6
 * with judge authoring; its API half shipped in phase 4 and stays (Deviations 39-41).
 *
 * **Then it was a page, and that was wrong too** (stakeholder, 2026-09-17). Three fields on a
 * full screen left a form stranded in a very wide empty stage, and gave the one screen in the
 * console with nothing to navigate its own navigation problem. A dialog is what this always
 * was: you come from the list, you make one thing, you go back to the list.
 *
 * The threshold stays because it is PANEL configuration rather than judge configuration — one
 * field now against a second panel version later.
 *
 * It is opened by `?new` on any route, so its two triggers — Home's button and the panel
 * switcher's menu item — are both plain links, and the back button closes it.
 */

/** Mirrors the server's `slugSchema`, so the field fails here rather than at the API. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

export const CreatePanelDialog = () => {
  const context = useConsoleContext()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { org?: string; new?: true }
  const queryClient = useQueryClient()

  const [name, setName] = useState('')
  // Tracked separately from `name` so typing a slug by hand stops it being overwritten —
  // a field that keeps rewriting itself is one people fight.
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [threshold, setThreshold] = useState('0.7')

  const orgId = context.state === 'ready' ? context.orgId : ''
  const orgSlug = context.state === 'ready' ? context.orgSlug : ''
  const effectiveSlug = slugEdited ? slug : slugify(name)

  const create = useMutation({
    mutationFn: async () => {
      const response = await api.internal.panels.$post(
        {
          // No `judges` key at all. The console never authors judges (ADR-0061), and the
          // server defaults the array — sending `[]` would work and would read as though
          // this screen had a judge step that produced nothing.
          json: { slug: effectiveSlug, name: name.trim(), threshold: Number(threshold) },
        },
        { headers: { 'X-LabelLoop-Org': orgId } },
      )
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async (data) => {
      // Held in memory only, for this tab. See `issued-key.ts` for why not storage.
      if (data.key !== null) rememberIssuedKey(data.panel_id, data.key.plaintext)
      // The switcher and Home both list panels, and there is now one more.
      await queryClient.invalidateQueries({ queryKey: ['panels', orgId] })
      // A panel opens on its Overview, which is where the key is revealed.
      await navigate({
        to: '/p/$panelSlug',
        params: { panelSlug: effectiveSlug },
        search: { org: orgSlug },
      })
    },
  })

  /**
   * **Ignore a dismissal that arrives in the same breath as the opening.**
   *
   * The triggers are router `Link`s, not a `DialogTrigger`. Radix marks a trigger's own click
   * so its dismissable layer knows to skip it; a link it has never heard of gets no such mark,
   * so the click that navigated is still in flight when the dialog mounts and the layer reads
   * it as an interaction OUTSIDE — opening and closing in one gesture. The symptom was a
   * button that appeared to do nothing, while the URL quietly lost its query string to the
   * close that followed.
   *
   * Opening by pasting the URL worked the whole time, which is what located it: the race needs
   * a click, so only client-side navigation could produce it.
   */
  const openedAt = useRef(0)
  useEffect(() => {
    if (search.new === true) openedAt.current = Date.now()
  }, [search.new])

  if (context.state !== 'ready') return null

  // Drops `new` and keeps the org, so closing returns to exactly the screen underneath.
  const close = () =>
    void navigate({ to: '.', search: { ...(search.org === undefined ? {} : { org: search.org }) } })

  const issues = create.error instanceof ApiError ? issuesOf(create.error) : {}
  const slugValid = effectiveSlug !== '' && SLUG.test(effectiveSlug)
  const thresholdValue = Number(threshold)
  const thresholdValid =
    threshold !== '' &&
    Number.isFinite(thresholdValue) &&
    thresholdValue >= 0 &&
    thresholdValue <= 1
  const submittable = name.trim() !== '' && slugValid && thresholdValid && !create.isPending

  return (
    // Dismissible on all three exits — Escape, the backdrop, Cancel — because abandoning a
    // form that has written nothing is safe. That is the opposite temperament from the key
    // reveal, which cannot be dismissed because dismissing it destroys the only copy
    // (6b decision 10).
    <Dialog
      open={search.new === true}
      onOpenChange={(open) => {
        if (open) return
        // 250ms is comfortably longer than one click's event sequence and far shorter than
        // any deliberate dismissal.
        if (Date.now() - openedAt.current < 250) return
        close()
      }}
    >
      {/*
        THREE BANDS — header, fields, actions — each with its own room, rather than one padded
        box with everything stacked inside it.

        Twice revised at review. The first draft was an essay (three sentences of description,
        a sentence of mono hint under every field). The second cut the words but kept the
        dialog's panel padding — 20–24px, the right number for a card on a page and a cramped
        one for a modal the whole screen defers to — at 30rem, which read as narrow and
        suffocating against the wide stage behind it. So: 34rem, 32px at the edges, and a
        header with space of its own. The bands are divided by space, not by fill.
      */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[34rem]">
        <DialogHeader className="gap-[var(--gap-inline)] px-[var(--space-8)] pt-[var(--space-8)] pb-[var(--space-6)]">
          <Eyebrow>{orgSlug}</Eyebrow>
          <DialogTitle className="text-title font-semibold leading-[var(--leading-title)] tracking-[var(--tracking-snug)]">
            Create panel
          </DialogTitle>
          {/*
            ONE sentence. It was three — collecting, judges later, key issued — and the dialog
            read as an essay with a form attached. What collecting MEANS is said on the panel's
            own Overview, the moment it is true; here it only needs to not surprise anyone.
          */}
          <DialogDescription>
            Starts collecting straight away, with an API key ready to use.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          {/*
            `--space-6` BETWEEN fields and `--gap-inline` WITHIN one. The first version put
            label, input and hint 4px apart and fields 16px apart: groups that were barely
            groups, separated by gaps that read as accidental.
          */}
          <div className="flex flex-col gap-[var(--space-6)] px-[var(--space-8)] pb-[var(--space-8)]">
            <Field id="name" label="Name" error={issues.name}>
              <Input
                id="name"
                value={name}
                placeholder="Triage routing gate"
                onChange={(event) => {
                  // An error answers the value that was SUBMITTED; once it changes, the error is stale.
                  create.reset()
                  setName(event.target.value)
                }}
                required
                autoFocus
              />
            </Field>

            {/*
            Slug and threshold share a row: both are short, and neither needs the width. The
            slug carries its `/p/` prefix so it reads as the URL it becomes, which says what a
            slug is without a sentence explaining it.
          */}
            <div className="grid grid-cols-[1fr_7rem] items-start gap-[var(--gap-stack)]">
              <Field id="slug" label="Slug" hint="Can’t be changed later." error={issues.slug}>
                <div // The wrapper wears the input's own border, fill and focus ring (from `ui/input.tsx`),
                  // so the prefix sits INSIDE the field rather than beside it.
                  className="flex h-9 min-w-0 items-center rounded-md border border-input shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 dark:bg-input/30"
                >
                  <Data className="select-none pl-[var(--pad-field-x)] text-foreground-faint">
                    /p/
                  </Data>
                  <Input
                    id="slug"
                    value={effectiveSlug}
                    onChange={(event) => {
                      create.reset()
                      setSlugEdited(true)
                      setSlug(slugify(event.target.value))
                    }}
                    className="h-full border-0 bg-transparent pl-[var(--space-1)] font-mono shadow-none focus-visible:ring-0 dark:bg-transparent"
                    required
                  />
                </div>
              </Field>

              <Field
                id="threshold"
                label="Threshold"
                hint="Pass mark, 0–1."
                error={issues.threshold}
              >
                <Input
                  id="threshold"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={threshold}
                  onChange={(event) => setThreshold(event.target.value)}
                  className="font-mono tabular-nums"
                  required
                />
              </Field>
            </div>

            {/*
          Field-level issues render beside their field above; anything the server reported
          without a path would otherwise vanish, so it lands here.
        */}
            {create.error !== null && Object.keys(issues).length === 0 ? (
              <p role="alert" className="m-0 text-ui text-fail">
                {create.error instanceof ApiError
                  ? create.error.treatment.detail
                  : 'The panel could not be created.'}
              </p>
            ) : null}
          </div>

          {/*
            Same surface as the rest of the dialog, separated by SPACE alone. A muted footer
            band was tried and rejected at review: on a dark surface a lighter fill does not
            recede, it reads as a raised slab — a second surface colour in a small dialog with
            no hierarchy to justify it.
          */}
          <DialogFooter className="px-[var(--space-8)] pb-[var(--space-8)]">
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!submittable}>
              {create.isPending ? 'Creating…' : 'Create panel'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const Field = ({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string
  label: string
  hint?: string
  error?: string | undefined
  children: React.ReactNode
}) => (
  <div className="flex min-w-0 flex-col gap-[var(--gap-inline)]">
    <label htmlFor={id} className="text-ui font-medium">
      {label}
    </label>
    {children}
    {/*
      ERROR SURFACE 1 (CONSOLE_FLOW §6): beside the field that caused it. A hint is plain
      muted text, not the mono eyebrow it used to borrow — mono is for data, and a sentence
      set in it reads as heavy and as something to parse rather than a note.
    */}
    {error !== undefined ? (
      <span role="alert" className="text-ui text-fail">
        {error}
      </span>
    ) : hint !== undefined ? (
      <span className="text-ui text-muted-foreground">{hint}</span>
    ) : null}
  </div>
)

/**
 * The server locates every form error by a dotted path, so the form can render each one
 * beside its own field (`slug`, and `judges.N.model` when judge authoring returns at M6).
 */
const issuesOf = (error: ApiError): Record<string, string> =>
  Object.fromEntries(error.issues.map((issue) => [issue.path, issue.message]))
