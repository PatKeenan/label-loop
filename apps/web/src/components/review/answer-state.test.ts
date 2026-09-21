import { describe, expect, test } from 'bun:test'
import { ANNOTATION_NOTE_MAX_LENGTH } from '@labelloop/contracts'
import { answerBody, canSave, keyToAction, noteRequired } from './answer-state.ts'

describe('the keyboard map (r6 decision 8)', () => {
  test.each([
    ['y', 'acceptable'],
    ['Y', 'acceptable'],
    ['n', 'not_acceptable'],
    ['s', 'skipped'],
    ['Enter', 'save'],
  ])('%s means %s', (key, action) => {
    expect(keyToAction({ key })).toBe(action as never)
  })

  test('a modified keystroke belongs to the browser, not to us', () => {
    expect(keyToAction({ key: 's', metaKey: true })).toBeNull()
    expect(keyToAction({ key: 'n', ctrlKey: true })).toBeNull()
    expect(keyToAction({ key: 'y', altKey: true })).toBeNull()
  })

  test('anything else is not ours either', () => {
    for (const key of ['a', 'Escape', ' ', 'ArrowDown']) expect(keyToAction({ key })).toBeNull()
  })
})

describe('when Save is allowed (ADR-0066, mirroring the API)', () => {
  test('no answer, no save', () => {
    expect(canSave(null, '')).toBe(false)
    expect(canSave(null, 'typed a note first')).toBe(false)
  })

  test('“acceptable” and “skipped” save with or without a note', () => {
    expect(canSave('acceptable', '')).toBe(true)
    expect(canSave('acceptable', 'nicely put')).toBe(true)
    expect(canSave('skipped', '')).toBe(true)
  })

  test('“not acceptable” needs a note, and whitespace is not a reason', () => {
    expect(noteRequired('not_acceptable')).toBe(true)
    expect(noteRequired('acceptable')).toBe(false)
    expect(canSave('not_acceptable', '')).toBe(false)
    expect(canSave('not_acceptable', '   \n ')).toBe(false)
    expect(canSave('not_acceptable', 'Refuses a refund the policy allows.')).toBe(true)
  })

  test('over the cap is refused, as the server refuses it', () => {
    const atCap = 'x'.repeat(ANNOTATION_NOTE_MAX_LENGTH)
    expect(canSave('not_acceptable', atCap)).toBe(true)
    expect(canSave('not_acceptable', `${atCap}x`)).toBe(false)
    // Also on an answer that does not require one: a paste is a paste.
    expect(canSave('acceptable', `${atCap}x`)).toBe(false)
  })
})

describe('what gets sent', () => {
  test('a skip carries no note, even if one was typed before the answer changed', () => {
    expect(answerBody('tr_1', 'skipped', 'typed earlier')).toEqual({
      item_id: 'tr_1',
      outcome: 'skipped',
    })
  })

  test('an empty note is omitted, never sent as an empty string', () => {
    expect(answerBody('tr_1', 'acceptable', '   ')).toEqual({
      item_id: 'tr_1',
      outcome: 'acceptable',
    })
  })

  test('a note is trimmed on the way out', () => {
    expect(answerBody('tr_1', 'not_acceptable', '  wrong policy quoted  ')).toEqual({
      item_id: 'tr_1',
      outcome: 'not_acceptable',
      note: 'wrong policy quoted',
    })
  })
})
