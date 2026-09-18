import { DISPLAY_NAME_RULES, SLUG_RULES, slugify } from '@labelloop/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api, auth } from '../api/client.ts'
import { meQuery } from '../api/queries.ts'
import { forgetIssuedKeys } from '../components/shell/issued-key.ts'
import { Data, Eyebrow } from '../components/shell/mark.tsx'
import { meetsRules, RuledField } from '../components/shell/rule-checklist.tsx'
import { Button } from '../components/ui/button.tsx'
import { Input } from '../components/ui/input.tsx'
import { ApiError, apiErrorFrom } from '../errors/api-error.ts'

/**
 * What a HAND-TYPED slug becomes: lowercased, spaces turned to hyphens, and nothing else — the
 * checklist says what is still wrong. Full `slugify` on every keystroke made a hyphen
 * untypeable (it stripped the trailing one as it was typed).
 */
const typedSlug = (value: string) => value.toLowerCase().replace(/ /g, '-')

/**
 * CREATE YOUR ORGANISATION — what a member of nothing sees, instead of a dead end (ADR-0063).
 *
 * It replaces a screen that said *"This account isn't in an organisation"* and offered no way
 * forward, which is where every genuinely new GitHub sign-in landed: M4's demo begins "sign in
 * with GitHub → create a panel", and without this the first half ended before the second.
 *
 * One step and two fields, the same shape as Create panel, and on purpose the same restraint:
 * one sentence, muted hints, space rather than fills. The creator becomes the org's ADMIN —
 * the only person who exists in it at this moment.
 *
 * Outside the shell, like sign-in: there is no organisation yet for a shell to be about.
 */
export const CreateOrgPage = ({ email }: { email: string }) => {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const effectiveSlug = slugEdited ? slug : slugify(name)

  const create = useMutation({
    mutationFn: async () => {
      const response = await api.internal.orgs.$post({
        json: { slug: effectiveSlug, name: name.trim() },
      })
      if (!response.ok) throw await apiErrorFrom(response)
      return (await response.json()).data
    },
    onSuccess: async (data) => {
      // `/me` now answers with a membership, which is what turns this screen into the console.
      await queryClient.fetchQuery({ ...meQuery, staleTime: 0 })
      await navigate({ to: '/', search: { org: data.slug }, replace: true })
    },
  })

  // The old screen had no way out at all — not even sign-out — because it lived outside the
  // shell whose account menu carries it.
  const signOut = useMutation({
    mutationFn: async () => {
      await auth.signOut()
    },
    onSuccess: async () => {
      forgetIssuedKeys()
      queryClient.clear()
      await navigate({ to: '/login', replace: true })
    },
  })

  const issues =
    create.error instanceof ApiError
      ? Object.fromEntries(create.error.issues.map((issue) => [issue.path, issue.message]))
      : {}
  // The server's own rules (`@labelloop/contracts`), so "enabled" means "will be accepted".
  const submittable =
    meetsRules(DISPLAY_NAME_RULES, name) &&
    meetsRules(SLUG_RULES, effectiveSlug) &&
    !create.isPending

  return (
    <div className="flex w-full max-w-[30rem] flex-col items-center gap-[var(--space-6)]">
      <form
        className="flex w-full flex-col gap-[var(--space-6)] rounded-lg border bg-card p-[var(--space-8)]"
        onSubmit={(event) => {
          event.preventDefault()
          create.mutate()
        }}
      >
        <div className="flex flex-col gap-[var(--gap-inline)]">
          <Eyebrow>LabelLoop</Eyebrow>
          <h1 className="m-0 text-title font-semibold tracking-[var(--tracking-snug)]">
            Create your organisation
          </h1>
          <p className="m-0 text-body text-muted-foreground">
            Panels, keys and traces all belong to one. You’ll be its admin.
          </p>
        </div>

        <RuledField
          id="org-name"
          label="Name"
          rules={DISPLAY_NAME_RULES}
          value={name}
          error={issues.name}
        >
          <Input
            id="org-name"
            value={name}
            placeholder="Acme support"
            onChange={(event) => {
              // An error answers the value that was SUBMITTED; once it changes, the error is stale.
              create.reset()
              setName(event.target.value)
            }}
            required
            autoFocus
          />
        </RuledField>

        <RuledField
          id="org-slug"
          label="Slug"
          hint="Can’t be changed later."
          rules={SLUG_RULES}
          value={effectiveSlug}
          error={issues.slug}
        >
          <Input
            id="org-slug"
            value={effectiveSlug}
            onChange={(event) => {
              create.reset()
              setSlugEdited(true)
              setSlug(typedSlug(event.target.value))
            }}
            className="font-mono"
            required
          />
        </RuledField>

        <div className="flex flex-col gap-[var(--gap-inline)]">
          <Button type="submit" disabled={!submittable}>
            {create.isPending ? 'Creating…' : 'Create organisation'}
          </Button>
          {/* Anything the server reported without a field path would otherwise vanish. */}
          {create.error !== null && Object.keys(issues).length === 0 ? (
            <p role="alert" className="m-0 text-ui text-fail">
              {create.error instanceof ApiError
                ? create.error.treatment.detail
                : 'The organisation could not be created.'}
            </p>
          ) : null}
        </div>
      </form>

      <p className="m-0 flex flex-wrap items-center justify-center gap-[var(--gap-tight)] text-ui text-muted-foreground">
        Signed in as <Data className="text-foreground">{email}</Data>
        <span className="text-foreground-faint">·</span>
        <button
          type="button"
          onClick={() => signOut.mutate()}
          disabled={signOut.isPending}
          className="underline underline-offset-4 hover:text-foreground"
        >
          Sign out
        </button>
      </p>
    </div>
  )
}
