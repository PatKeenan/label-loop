import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../api/client.ts'
import { useConsoleContext } from '../components/shell/context.ts'
import { rememberIssuedKey } from '../components/shell/issued-key.ts'
import { Data, Eyebrow } from '../components/shell/mark.tsx'
import { PageHead } from '../components/shell/page-head.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { ApiError, apiErrorFrom } from '../errors/api-error.ts'

/**
 * CREATING A PANEL IS ONE STEP — name, slug, threshold (6c decision 1, ADR-0061).
 *
 * **There was a four-step wizard here, and its own review deleted it.** Panel details →
 * judges → model picker → review was the plan's shape; r3 of the mockup cut it to one step
 * because judges cannot be authored before error analysis, so a wizard that collects them is
 * collecting guesses the product's own loop exists to replace. The model picker moved to M6
 * with judge authoring; its API half shipped in phase 4 and stays (Deviations 39–41).
 *
 * The threshold stays because it is PANEL configuration rather than judge configuration —
 * one field now against a second panel version later.
 *
 * What this screen creates is a COLLECTING panel with a key, in one request. The key's
 * plaintext comes back exactly once, and the landing screen is the reveal.
 */

/** Mirrors the server's `slugSchema`, so the field fails here rather than at the API. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

export const PanelCreatePage = () => {
  const context = useConsoleContext()
  const navigate = useNavigate()
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

  if (context.state !== 'ready') return null

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
    <>
      <PageHead scope={[orgSlug]} title="Create panel" />

      <form
        className="flex max-w-[var(--measure)] flex-col gap-[var(--gap-stack)] rounded-lg border bg-card px-[var(--pad-panel-x)] py-[var(--pad-panel-y)]"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <p className="m-0 text-body text-muted-foreground">
          A new panel starts <strong>collecting</strong>: it accepts calls, stores every trace and
          convenes no judges. Judges come later, from what an expert finds in this traffic — there
          is nothing to configure about them yet.
        </p>

        <Field
          id="name"
          label="Name"
          hint="What a person calls it. “Triage routing gate”."
          error={issues['name']}
        >
          <Input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
            autoFocus
          />
        </Field>

        <Field
          id="slug"
          label="Slug"
          hint="Lowercase, hyphenated. It appears in the URL and in every API call, and it cannot be changed."
          error={issues['slug']}
        >
          <Input
            id="slug"
            value={effectiveSlug}
            onChange={(event) => {
              setSlugEdited(true)
              setSlug(slugify(event.target.value))
            }}
            required
          />
        </Field>

        <Field
          id="threshold"
          label="Threshold"
          hint="The score a panel must reach to pass, from 0 to 1. It does nothing while the panel is collecting, and it is here because it describes the panel rather than any judge."
          error={issues['threshold']}
        >
          <Input
            id="threshold"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            required
          />
        </Field>

        <div className="flex items-center gap-[var(--gap-inline)]">
          <Button type="submit" disabled={!submittable}>
            {create.isPending ? 'Creating…' : 'Create panel'}
          </Button>
          <Data>a key is issued with it</Data>
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
      </form>
    </>
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
  hint: string
  error?: string | undefined
  children: React.ReactNode
}) => (
  <div className="flex flex-col gap-[var(--gap-tight)]">
    <label htmlFor={id} className="text-ui">
      {label}
    </label>
    {children}
    {/* ERROR SURFACE 1 (CONSOLE_FLOW §6): beside the field that caused it. */}
    {error === undefined ? (
      <Eyebrow className="normal-case tracking-normal">{hint}</Eyebrow>
    ) : (
      <span role="alert" className="text-ui text-fail">
        {error}
      </span>
    )}
  </div>
)

/**
 * The server locates every form error by a dotted path, so the form can render each one
 * beside its own field (`slug`, and `judges.N.model` when judge authoring returns at M6).
 */
const issuesOf = (error: ApiError): Record<string, string> =>
  Object.fromEntries(error.issues.map((issue) => [issue.path, issue.message]))
