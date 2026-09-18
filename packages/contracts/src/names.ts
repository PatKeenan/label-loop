import { z } from 'zod'

/**
 * THE RULES FOR A NAME AND A SLUG, defined once for both sides of the wire.
 *
 * The API validates with the schemas at the bottom of this file; the console renders the SAME
 * rule list as a live checklist under each field (✓ as a rule is met, ✕ as it is broken). A
 * checklist written separately in the console would eventually promise something the server
 * refuses, which is worse than no checklist — so the console imports these rules rather than
 * restating them.
 *
 * Each rule is a label a person reads and a test over the RAW input. The label is the whole
 * explanation: it is what the checklist shows and what the server returns as the field error.
 */
export type NameRule = {
  id: string
  /** Phrased as the requirement, so it reads correctly beside both a ✓ and a ✕. */
  label: string
  test: (value: string) => boolean
}

// ── Display names ────────────────────────────────────────────────────────────────────────────

/**
 * C0 and C1 control characters, which includes newline, tab, NUL and the ESC that starts a
 * terminal escape sequence. A name with a newline breaks every table row it appears in; an
 * escape sequence rewrites the terminal of whoever reads a log or an export containing it.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the rule — this regex exists to refuse them.
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/u

/**
 * Characters that change how text is DISPLAYED without being visible themselves:
 *
 * - bidi embeddings, overrides and isolates (U+202A–202E, U+2066–2069) and the directional
 *   marks (U+200E, U+200F, U+061C) — "Trojan Source": a key stored as `\u202Eyek-dor` renders as
 *   something else entirely, and the Keys list and audit log are where that spoofing pays;
 * - zero-width space, word joiner and BOM (U+200B, U+2060, U+FEFF) — two names that look the
 *   same and are not, or a name that looks non-empty and shows nothing.
 *
 * **U+200D, the zero-width JOINER, is deliberately allowed**: emoji sequences like 👩‍💻 are built
 * from it, and refusing it would refuse ordinary names people type.
 */
const INVISIBLE = /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/u

export const DISPLAY_NAME_MAX = 80

/**
 * Normalised before it is measured or stored: NFC, so `é` typed as one code point or as `e` +
 * a combining accent is the same name, and trimmed.
 */
export const normaliseDisplayName = (value: string): string => value.normalize('NFC').trim()

/**
 * A display name — for an organisation, a panel, a key or a judge. ANY script is welcome
 * (accents, CJK, emoji); what is refused is only what is never legitimately part of a name.
 */
export const DISPLAY_NAME_RULES: readonly NameRule[] = [
  {
    id: 'length',
    label: `1 to ${DISPLAY_NAME_MAX} characters`,
    test: (value) => {
      // Characters as a person counts them — code points, not UTF-16 units, so an emoji is one.
      const length = [...normaliseDisplayName(value)].length
      return length >= 1 && length <= DISPLAY_NAME_MAX
    },
  },
  {
    id: 'no-control',
    label: 'No line breaks, tabs or control characters',
    test: (value) => !CONTROL.test(value),
  },
  {
    id: 'no-invisible',
    label: 'No invisible or text-direction characters',
    test: (value) => !INVISIBLE.test(value),
  },
]

// ── Slugs ────────────────────────────────────────────────────────────────────────────────────

export const SLUG_MAX = 64

/**
 * A slug — for an organisation, a panel or a judge. It appears in URLs, in API paths and, for a
 * judge, as a key in every `/v1` response, so the alphabet is as small as it can be: nothing in
 * it can need escaping anywhere it goes.
 *
 * The rules decompose `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` into parts a person can act on; together
 * they are exactly that expression (asserted in `names.test.ts`).
 */
export const SLUG_RULES: readonly NameRule[] = [
  {
    id: 'starts-with-letter',
    label: 'Starts with a letter',
    test: (value) => /^[a-z]/.test(value),
  },
  {
    id: 'alphabet',
    label: 'Only lowercase letters, numbers and hyphens',
    test: (value) => value !== '' && /^[a-z0-9-]+$/.test(value),
  },
  {
    id: 'hyphens',
    label: 'No double, leading or trailing hyphens',
    test: (value) => value !== '' && !/--|^-|-$/.test(value),
  },
  {
    id: 'length',
    label: `${SLUG_MAX} characters or fewer`,
    test: (value) => value.length >= 1 && value.length <= SLUG_MAX,
  },
]

/**
 * A slug suggested from a display name — what the console fills the slug field with as a name is
 * typed. Its output always satisfies `SLUG_RULES` or is empty (asserted in `names.test.ts`): a
 * suggestion the server would refuse is the drift this file exists to prevent, and the create
 * dialog's own copy once turned "1st pass" into `1st-pass`, which it accepted and the server did not.
 */
export const slugify = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // é → e: strip the accents NFKD separated out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '') // must start with a letter
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')

// ── The schemas the API validates with ──────────────────────────────────────────────────────

/**
 * One issue PER broken rule, each carrying the rule's own label — so the server's 422 names the
 * same requirement the checklist showed, located at the field that broke it.
 */
const byRules = (rules: readonly NameRule[]) => (value: string, ctx: z.RefinementCtx) => {
  for (const rule of rules) {
    if (!rule.test(value)) ctx.addIssue({ code: 'custom', message: rule.label })
  }
}

/** Validated on the RAW input, then normalised — the rules judge what was sent. */
export const displayNameSchema = z
  .string()
  .superRefine(byRules(DISPLAY_NAME_RULES))
  .transform(normaliseDisplayName)

export const slugSchema = z.string().superRefine(byRules(SLUG_RULES))
