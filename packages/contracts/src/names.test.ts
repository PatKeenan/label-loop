import { describe, expect, test } from 'bun:test'
import {
  DISPLAY_NAME_MAX,
  DISPLAY_NAME_RULES,
  displayNameSchema,
  SLUG_RULES,
  slugify,
  slugSchema,
} from './names.ts'

const broken = (rules: typeof DISPLAY_NAME_RULES, value: string) =>
  rules.filter((rule) => !rule.test(value)).map((rule) => rule.id)

describe('display names', () => {
  test('ordinary names in any script pass — this is not an ASCII rule', () => {
    for (const name of [
      'Support reply gate',
      'Café Müller',
      '日本語のパネル',
      'Тестовая группа',
      'Ship it 🚀',
      // Built from U+200D, the zero-width JOINER — which must stay allowed.
      'Dev team 👩‍💻',
      '<script>alert(1)</script>', // Harmless as TEXT; React escapes it. Not this rule's job.
    ]) {
      expect(broken(DISPLAY_NAME_RULES, name)).toEqual([])
      expect(displayNameSchema.safeParse(name).success).toBe(true)
    }
  })

  test('control characters are refused — newline, tab, NUL, ESC', () => {
    for (const name of ['two\nlines', 'tab\there', 'nul\u0000', 'esc \u001B[31mred']) {
      expect(broken(DISPLAY_NAME_RULES, name)).toEqual(['no-control'])
    }
  })

  test('bidi overrides and invisible characters are refused (Trojan Source)', () => {
    for (const name of [
      '\u202Eyek-dorp', // right-to-left OVERRIDE: displays reversed
      'prod\u2066-key\u2069', // isolate
      'prod\u200Bkey', // zero-width space
      '\uFEFFprod', // BOM
      'prod\u200Fkey', // right-to-left mark
    ]) {
      expect(broken(DISPLAY_NAME_RULES, name)).toEqual(['no-invisible'])
    }
  })

  test('length is counted in characters a person sees, after trimming', () => {
    expect(broken(DISPLAY_NAME_RULES, '   ')).toEqual(['length'])
    expect(broken(DISPLAY_NAME_RULES, 'a'.repeat(DISPLAY_NAME_MAX))).toEqual([])
    expect(broken(DISPLAY_NAME_RULES, 'a'.repeat(DISPLAY_NAME_MAX + 1))).toEqual(['length'])
    // 80 emoji are 160 UTF-16 units and still 80 characters.
    expect(broken(DISPLAY_NAME_RULES, '🚀'.repeat(DISPLAY_NAME_MAX))).toEqual([])
  })

  test('the schema normalises to NFC and trims, so one name is stored one way', () => {
    const decomposed = 'Café' // e + combining acute
    expect(displayNameSchema.parse(`  ${decomposed}  `)).toBe('Café')
  })

  test('the server reports each broken rule by the SAME label the checklist shows', () => {
    const result = displayNameSchema.safeParse('bad\n\u202Ename')
    expect(result.success).toBe(false)
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'No line breaks, tabs or control characters',
      'No invisible or text-direction characters',
    ])
  })
})

describe('slugs', () => {
  /** The expression every slug in the API was validated with before these rules existed. */
  const ORIGINAL = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

  test('the rules together are EXACTLY the original expression', () => {
    for (const slug of [
      'issue-triage',
      'a',
      'a1-b2',
      'x'.repeat(64),
      '',
      '1abc',
      '-abc',
      'abc-',
      'a--b',
      'Abc',
      'a_b',
      'a b',
      'a.b',
      'café',
      'a/b',
      'a%20b',
    ]) {
      const byRules = SLUG_RULES.every((rule) => rule.test(slug))
      expect(byRules).toBe(ORIGINAL.test(slug) && slug.length <= 64)
      expect(slugSchema.safeParse(slug).success).toBe(byRules)
    }
  })

  test('each broken slug names the specific rule a person can fix', () => {
    expect(broken(SLUG_RULES, '1abc')).toEqual(['starts-with-letter'])
    expect(broken(SLUG_RULES, 'my_panel')).toEqual(['alphabet'])
    expect(broken(SLUG_RULES, 'my--panel')).toEqual(['hyphens'])
    expect(broken(SLUG_RULES, `a${'b'.repeat(64)}`)).toEqual(['length'])
  })
})

describe('slugify', () => {
  test('suggests a slug the rules accept — or nothing, never an invalid one', () => {
    for (const name of [
      'Support reply gate',
      '1st pass',
      'Café Müller',
      '  --weird__name--  ',
      '日本語',
      'x'.repeat(200),
      'a -b',
    ]) {
      const slug = slugify(name)
      if (slug !== '') expect(SLUG_RULES.every((rule) => rule.test(slug))).toBe(true)
    }
    expect(slugify('Support reply gate')).toBe('support-reply-gate')
    expect(slugify('1st pass')).toBe('st-pass')
    expect(slugify('Café Müller')).toBe('cafe-muller')
  })
})
