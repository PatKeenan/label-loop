import { describe, expect, test } from 'bun:test'
import { validateConsoleSearch } from './context.ts'

/**
 * The router merges a validator's result OVER the raw query string, so these assert that every
 * key comes back — `undefined` when absent — rather than merely that bad values are absent.
 * An omitted key would pass a `toBeUndefined` and still leak the raw value in the browser.
 */
describe('validateConsoleSearch', () => {
  test('a real org slug is kept', () => {
    expect(validateConsoleSearch({ org: 'acme' })).toEqual({ org: 'acme', new: undefined })
  })

  test('an empty or non-string org is returned as undefined, not left out', () => {
    for (const org of ['', 42, undefined]) {
      const search = validateConsoleSearch({ org })
      expect(Object.hasOwn(search, 'org')).toBe(true)
      expect(search.org).toBeUndefined()
    }
  })

  test('`new` in any truthy spelling opens the dialog, and anything else closes it', () => {
    for (const isNew of ['', 'true', true, '1', 1]) {
      expect(validateConsoleSearch({ new: isNew }).new).toBe(true)
    }
    for (const isNew of [false, 'false', 0, undefined]) {
      const search = validateConsoleSearch({ new: isNew })
      expect(Object.hasOwn(search, 'new')).toBe(true)
      expect(search.new).toBeUndefined()
    }
  })
})
