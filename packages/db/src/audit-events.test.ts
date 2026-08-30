import { afterAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { appClient, migratorClient, sqlStateOf } from './test-support.ts'

/**
 * The append-only guarantee, asserted by trying to break it (CONVENTIONS.md "Data rules").
 *
 * This is the difference between an append-only claim and an append-only guarantee. The
 * app role can add to `audit_events` and read it back, and Postgres itself refuses to let
 * it change or remove anything — so the answer to "how do you know nobody edited the audit
 * log?" is this file rather than a paragraph asserting that no code path does it.
 */

const app = appClient()
const migrator = migratorClient()

const INSUFFICIENT_PRIVILEGE = '42501'

afterAll(async () => {
  await app.close()
  await migrator.close()
})

/**
 * Run a query that is expected to fail and hand back the error.
 *
 * Bun's SQL query object executes when it is awaited, so awaiting the same one twice —
 * once through `expect().rejects` and again to inspect the error — runs the statement
 * twice and leaks a pooled connection per extra run. One execution, one result.
 */
const rejection = async (query: Promise<unknown>): Promise<unknown> => {
  const outcome = await query.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

const seedEvent = async () => {
  const id = newId('aud_')
  await app`
    INSERT INTO audit_events (id, actor_type, action)
    VALUES (${id}, 'system', 'test.event')
  `
  return id
}

describe('audit_events is append-only, enforced by Postgres', () => {
  test('the app role can INSERT', async () => {
    const id = await seedEvent()
    const rows = await app`SELECT id FROM audit_events WHERE id = ${id}`
    expect(rows).toHaveLength(1)
  })

  test('the app role CANNOT UPDATE', async () => {
    const id = await seedEvent()
    const error = await rejection(app`UPDATE audit_events SET action = 'tampered' WHERE id = ${id}`)
    // Asserting the privilege code, not merely that it threw: a bare "it threw" would
    // also pass on a typo in the statement, which would leave the guarantee untested.
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)

    const rows = (await app`SELECT action FROM audit_events WHERE id = ${id}`) as Array<{
      action: string
    }>
    expect(rows[0]?.action).toBe('test.event')
  })

  test('the app role CANNOT DELETE', async () => {
    const id = await seedEvent()
    const error = await rejection(app`DELETE FROM audit_events WHERE id = ${id}`)
    expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE)

    const rows = await app`SELECT id FROM audit_events WHERE id = ${id}`
    expect(rows).toHaveLength(1)
  })

  test('TRUNCATE is refused too — the obvious way around a missing DELETE', async () => {
    expect(sqlStateOf(await rejection(app`TRUNCATE audit_events`))).toBe(INSUFFICIENT_PRIVILEGE)
  })

  test('the grant itself is INSERT and SELECT and nothing else', async () => {
    const rows = (await migrator`
      SELECT privilege_type FROM information_schema.table_privileges
      WHERE grantee = 'labelloop_app' AND table_name = 'audit_events'
      ORDER BY privilege_type
    `) as Array<{ privilege_type: string }>
    expect(rows.map((r) => r.privilege_type)).toEqual(['INSERT', 'SELECT'])
  })
})
