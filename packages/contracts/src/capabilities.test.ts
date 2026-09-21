import { describe, expect, test } from 'bun:test'
import { can, type OrgRole, type PermissionRequest, ROLES } from './capabilities.ts'

/**
 * The map itself. The API's role × route matrix (`require-permission.test.ts`) proves each
 * route asks for the right thing; this file proves each role is granted the right things.
 */

const EVERY_REQUEST: readonly PermissionRequest[] = [
  { panel: ['read'] },
  { panel: ['create'] },
  { key: ['read'] },
  { key: ['issue'] },
  { key: ['revoke'] },
  { model: ['read'] },
  { judge: ['read'] },
  { trace: ['read'] },
  { annotation: ['create'] },
  { annotation: ['curate'] },
  { member: ['read'] },
  { member: ['manage'] },
]

const granted = (role: OrgRole) => EVERY_REQUEST.filter((request) => can(role, request))

describe('what each role may do', () => {
  test('an admin may do everything', () => {
    expect(granted('admin')).toEqual([...EVERY_REQUEST])
  })

  test('an engineer may do everything except manage members', () => {
    expect(can('engineer', { member: ['manage'] })).toBe(false)
    expect(granted('engineer')).toEqual(EVERY_REQUEST.filter((r) => r.member?.[0] !== 'manage'))
  })

  test('an engineer may annotate (ADR-0064)', () => {
    expect(can('engineer', { annotation: ['create'] })).toBe(true)
  })

  test('an annotator may annotate and nothing else', () => {
    expect(granted('annotator')).toEqual([{ annotation: ['create'] }])
    expect(can('annotator', { key: ['read'] })).toBe(false)
    expect(can('annotator', { trace: ['read'] })).toBe(false)
  })

  test('an annotator may NOT curate (ADR-0083)', () => {
    // Choosing what somebody's afternoon is spent on is not the same act as spending it, and
    // assigning a set grants read access to its traces — so it is the admin's and engineer's.
    expect(can('annotator', { annotation: ['curate'] })).toBe(false)
    expect(can('admin', { annotation: ['curate'] })).toBe(true)
    expect(can('engineer', { annotation: ['curate'] })).toBe(true)
  })

  test('a guest expert may do nothing until M8 (ADR-0072)', () => {
    expect(granted('guest_expert')).toEqual([])
  })
})

describe('deny by default', () => {
  test('every role in the enum has an entry in the map', () => {
    // An absent entry would read as "nothing" and pass the guest-expert test by accident, so
    // this asserts presence through a request every staff role is granted.
    expect(ROLES.filter((role) => can(role, { annotation: ['create'] }))).toEqual([
      'admin',
      'engineer',
      'annotator',
    ])
  })

  test('an empty request is refused, even for an admin', () => {
    expect(can('admin', {})).toBe(false)
  })

  test('a role the map does not know is refused', () => {
    expect(can('owner' as OrgRole, { panel: ['read'] })).toBe(false)
  })

  test('every action in a request must be granted', () => {
    expect(can('engineer', { member: ['read', 'manage'] })).toBe(false)
    expect(can('engineer', { panel: ['read'], member: ['manage'] })).toBe(false)
    expect(can('admin', { panel: ['read'], member: ['manage'] })).toBe(true)
  })
})
