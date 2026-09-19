import { afterAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { appClient } from '../test-support.ts'

/**
 * Migration 0013 (ADR-0074): the four roles of ADR-0073 added BESIDE `artifact` and `context`,
 * with a backfill, and nothing removed.
 *
 * The local and CI databases are already past 0013 by the time a test runs, so the backfill
 * is proven the only way that stays honest afterwards: a row is written the way pre-0013 code
 * wrote it — `artifact` and `context`, no `output` — and the migration's OWN `UPDATE`, read
 * from the file, is run over it. All inside a transaction that is rolled back, so the
 * statement (which is unscoped by design) touches nothing but the fixture.
 */

const MIGRATION = new URL('../../migrations/0013_native_shapes.sql', import.meta.url).pathname
const client = appClient()

afterAll(async () => {
  await client.close()
})

const backfillStatement = async (): Promise<string> => {
  const sql = await Bun.file(MIGRATION).text()
  const statement = sql
    .split('--> statement-breakpoint')
    .map((part) => part.trim())
    .find((part) => part.includes('UPDATE "traces"'))
  if (statement === undefined) throw new Error('0013 has no backfill UPDATE')
  return statement
}

describe('migration 0013 expands and never contracts', () => {
  test('it removes nothing — no DROP, DELETE or TRUNCATE, so every row survives it', async () => {
    const sql = (await Bun.file(MIGRATION).text())
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\b|\bTRUNCATE\b/i)
  })

  test('the backfill maps a pre-migration row exactly, and leaves a new row alone', async () => {
    const connection = await client.pool.connect()
    try {
      await connection.query('BEGIN')
      const orgId = newId('org_')
      const panelId = newId('pnl_')
      const panelVersionId = newId('pnv_')
      const legacy = newId('tr_')
      const current = newId('tr_')
      await connection.query(`INSERT INTO orgs (id, slug, name) VALUES ($1, $1, 'backfill')`, [
        orgId,
      ])
      await connection.query(
        `INSERT INTO panels (id, org_id, slug, name) VALUES ($1, $2, 'backfill', 'Backfill')`,
        [panelId, orgId],
      )
      await connection.query(
        `INSERT INTO panel_versions (id, panel_id, version, threshold) VALUES ($1, $2, 1, 0.5)`,
        [panelVersionId, panelId],
      )
      const insert = `
        INSERT INTO traces (id, org_id, panel_id, panel_version_id, request_id, artifact,
                            context, output, complete, threshold)
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, true, 0.5)`
      // Exactly what pre-0013 code wrote: text, a string map, and no output.
      await connection.query(insert, [
        legacy,
        orgId,
        panelId,
        panelVersionId,
        'a'.repeat(32),
        '{"looks": "like json"} but is text',
        JSON.stringify({ source: 'github', repo: 'acme/web' }),
        null,
      ])
      // What post-0013 code writes: an output already, and no context.
      await connection.query(insert, [
        current,
        orgId,
        panelId,
        panelVersionId,
        'b'.repeat(32),
        'the reply',
        null,
        JSON.stringify('the reply'),
      ])

      await connection.query(await backfillStatement())

      const { rows } = await connection.query(
        `SELECT id, jsonb_typeof(output) AS output_type, output #>> '{}' AS output_text,
                reference, input, metadata
         FROM traces WHERE id = ANY($1) ORDER BY id`,
        [[legacy, current]],
      )
      expect(rows.find((row) => row.id === legacy)).toEqual({
        id: legacy,
        // A jsonb STRING holding the artifact byte for byte — never parsed, even when the
        // text happens to look like JSON.
        output_type: 'string',
        output_text: '{"looks": "like json"} but is text',
        reference: { source: 'github', repo: 'acme/web' },
        // Not invented: a legacy trace never recorded what its agent was given.
        input: null,
        metadata: null,
      })
      expect(rows.find((row) => row.id === current)).toMatchObject({
        output_text: 'the reply',
        reference: null,
      })
    } finally {
      await connection.query('ROLLBACK')
      connection.release()
    }
  })
})
