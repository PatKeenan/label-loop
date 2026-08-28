import { describe, expect, test } from 'bun:test'
import { getAuthTables } from 'better-auth/db'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { account, session, user, verification } from './auth.ts'

/**
 * A drift check against better-auth's own idea of its schema.
 *
 * better-auth's tables are its contract, not ours, and we hand-write them so they land in
 * OUR forward-only migration stream rather than being created by the library at runtime.
 * The cost of hand-writing is drift: a version bump that adds or renames a field would
 * otherwise surface as a runtime failure on somebody's login, in production, months later.
 *
 * So the library is asked what it expects and the answer is compared to what we declared.
 * A `bun update` that changes the auth schema now fails here — loudly, in CI, next to the
 * migration that would need writing.
 */

const AUTH_OPTIONS = { emailAndPassword: { enabled: true } }

/** Drizzle property names, which are what better-auth's adapter matches fields against. */
const propertiesOf = (table: Parameters<typeof getTableConfig>[0]): string[] =>
  getTableConfig(table)
    .columns.map((column) => column.name)
    .sort()

/**
 * better-auth names fields in camelCase; our columns are snake_case like the rest of the
 * database. The adapter bridges that, so the comparison has to as well.
 */
const toColumnName = (field: string): string =>
  field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

const expectedColumns = (model: string): string[] => {
  const tables = getAuthTables(AUTH_OPTIONS)
  const table = tables[model]
  if (table === undefined) throw new Error(`better-auth no longer defines a "${model}" table`)
  return ['id', ...Object.keys(table.fields).map(toColumnName)].sort()
}

describe('our better-auth tables match what better-auth expects', () => {
  const cases = [
    ['user', user],
    ['session', session],
    ['account', account],
    ['verification', verification],
  ] as const

  for (const [model, table] of cases) {
    test(`${model} has exactly the columns better-auth declares`, () => {
      expect(propertiesOf(table)).toEqual(expectedColumns(model))
    })
  }

  test('better-auth still defines exactly the four core models we declare', () => {
    expect(Object.keys(getAuthTables(AUTH_OPTIONS)).sort()).toEqual([
      'account',
      'session',
      'user',
      'verification',
    ])
  })
})

describe('the auth schema stays in our migration stream', () => {
  test('every auth table is a real Drizzle table with a primary key', () => {
    for (const [, table] of [
      ['user', user],
      ['session', session],
      ['account', account],
      ['verification', verification],
    ] as const) {
      const config = getTableConfig(table)
      const primaryKeys = config.columns.filter((column) => column.primary)
      expect(primaryKeys.map((column) => column.name)).toEqual(['id'])
    }
  })
})
