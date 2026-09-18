import { describe, expect, test } from 'bun:test'
import { safeRedirect } from './redirect.ts'

describe('safeRedirect', () => {
  test('a path on this origin, with its search and hash, is kept exactly', () => {
    expect(safeRedirect('/')).toBe('/')
    expect(safeRedirect('/p/triage/traces?org=acme')).toBe('/p/triage/traces?org=acme')
    expect(safeRedirect('/p/triage#snippet')).toBe('/p/triage#snippet')
  })

  test('anything that can leave the origin is refused', () => {
    expect(safeRedirect('https://evil.example/p/triage')).toBeUndefined()
    // Protocol-relative: the browser reads both of these as a different HOST.
    expect(safeRedirect('//evil.example')).toBeUndefined()
    expect(safeRedirect('/\\evil.example')).toBeUndefined()
    expect(safeRedirect('javascript:alert(1)')).toBeUndefined()
    expect(safeRedirect('p/triage')).toBeUndefined()
  })

  test('the login page itself is not a destination', () => {
    expect(safeRedirect('/login')).toBeUndefined()
    expect(safeRedirect('/login?redirect=/p/triage')).toBeUndefined()
  })

  test('a missing or non-string value is absent, not an error', () => {
    expect(safeRedirect(undefined)).toBeUndefined()
    expect(safeRedirect('')).toBeUndefined()
    expect(safeRedirect(['/p/triage'])).toBeUndefined()
  })
})
