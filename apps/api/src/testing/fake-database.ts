import { type Database, expectedMigrations } from '@labelloop/db'

/**
 * A database stand-in for the tests that are not about the database.
 *
 * Most of the API's tests are about routing, the error envelope and the logger; making
 * them start a Postgres would make them slow, order-dependent and prone to failing for
 * reasons that have nothing to do with what they assert. The tests that ARE about the
 * database live in `packages/db` and run against a real one.
 *
 * It answers the two queries `/readyz` makes and nothing else, which is deliberate: the
 * moment a route needs more than this, it belongs in an integration test with real
 * Postgres rather than a richer fake that drifts from what Postgres actually does.
 */

export type FakeDatabaseOptions = {
  /** Reject every query, as an unreachable or overloaded Postgres would. */
  failing?: Error
  /** Reply as though this many migrations were applied. Defaults to "current". */
  applied?: number
  /** Never settle, so the readiness probe's timeout is what ends the request. */
  hanging?: boolean
}

const isTemplate = (value: unknown): value is TemplateStringsArray =>
  Array.isArray(value) && 'raw' in value

export const fakeDatabase = ({ failing, applied, hanging }: FakeDatabaseOptions = {}): Database => {
  const expected = expectedMigrations()

  const client = (...args: unknown[]): unknown => {
    // Called as `client(identifier)` for a table name rather than as a tagged template:
    // hand back a marker, since nothing here interpolates it into real SQL.
    if (!isTemplate(args[0])) return { identifier: String(args[0]) }

    if (hanging === true) return new Promise(() => {})
    if (failing !== undefined) return Promise.reject(failing)

    const sql = args[0].join(' ')
    if (sql.includes('applied')) {
      return Promise.resolve([{ applied: applied ?? expected.count, newest: expected.newest }])
    }
    return Promise.resolve([{ '?column?': 1 }])
  }

  // The single cast in this file, and the reason for it: `Database` is Drizzle's full
  // query-builder type, and structurally satisfying it would mean reimplementing Drizzle.
  // The fake honours the only surface the app touches at P3 — `client` and `close` — and
  // anything reaching past that should be using a real database instead.
  return Object.assign(client, {
    // `client` refers back to the callable, mirroring the real handle: the readiness
    // checks reach for `db.client` rather than the query builder, because "is Postgres
    // answering" is not a question the ORM should be in the middle of.
    client,
    close: async () => {},
  }) as unknown as Database
}
