import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Annotations } from './trace-drawer.tsx'

/**
 * THE ANNOTATIONS BLOCK (M5 phase 6), rendered to markup — the same way `markdown.test.tsx`
 * tests its component, and for the same reason: these are rules about what a screen says,
 * and a rule only worth having is one that fails when somebody changes it.
 *
 * The four claims are all "the console does not tell the reader something untrue": a skip is
 * not a failure, a superseded answer is not silently forgotten, an address is never invented
 * for someone with no name, and nobody having read a trace is said out loud.
 */
const row = (overrides: Partial<Parameters<typeof Annotations>[0]['annotations'][number]>) => ({
  id: 'ann_01',
  annotator_id: 'usr_01',
  annotator_name: 'Sam Okafor',
  annotator_email: 'sam@example.test',
  outcome: 'acceptable' as const,
  note: null,
  revisions: 0,
  created_at: '2026-09-20T10:00:00.000Z',
  ...overrides,
})

const html = (...annotations: ReturnType<typeof row>[]) =>
  renderToStaticMarkup(<Annotations annotations={annotations} />)

describe('Annotations — what people said about this trace', () => {
  test('nobody having read it is SAID, not left as an empty section', () => {
    const out = html()
    expect(out).toContain('Nobody has annotated this trace yet.')
    // No count beside the heading when there is nothing to count.
    expect(out).not.toContain('Annotations ·')
  })

  test('the outcome is the colour and the note is the body', () => {
    const out = html(row({ outcome: 'not_acceptable', note: 'It never names the browser.' }))
    expect(out).toContain('not acceptable')
    expect(out).toContain('text-fail')
    expect(out).toContain('It never names the browser.')
  })

  test('a SKIP is neutral — not a failure, and not a pass', () => {
    const out = html(row({ outcome: 'skipped' }))
    expect(out).toContain('skipped')
    expect(out).toContain('text-neutral')
    expect(out).not.toContain('text-fail')
    expect(out).not.toContain('text-success')
  })

  test('a changed mind says so; an unchanged one says nothing', () => {
    expect(html(row({ revisions: 1 }))).toContain('changed')
    expect(html(row({ revisions: 2 }))).toContain('changed 2×')
    expect(html(row({ revisions: 0 }))).not.toContain('changed')
  })

  test('someone with no name is shown their address, never a blank', () => {
    const out = html(row({ annotator_name: '', annotator_email: 'nameless@example.test' }))
    expect(out).toContain('nameless@example.test')
  })
})
