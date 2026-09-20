import { describe, expect, test } from 'bun:test'
import { Glob } from 'bun'

/**
 * The two halves of the native-shapes change, asserted against the migration FILES: 0013
 * expands and backfills, 0014 contracts (ADR-0073, ADR-0074).
 *
 * File-level, because neither can be exercised against a database any more. Both have run
 * everywhere by the time a test does, and 0014 removed the columns 0013's backfill reads — so
 * a row-level replay of it, which this file held while the columns existed, is not a weaker
 * test now but an impossible one. What remains is the property that mattered throughout and
 * still can be checked: **the migration stream never removed a trace**, only columns, and only
 * after their contents had been copied elsewhere.
 */

const MIGRATIONS = new URL('../../migrations', import.meta.url).pathname
const read = (name: string) => Bun.file(`${MIGRATIONS}/${name}`).text()

/** SQL with comment lines stripped — the prose below discusses `DELETE` and `DROP` freely. */
const statements = async (name: string) =>
  (await read(name))
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')

describe('0013 expands and backfills, removing nothing', () => {
  test('it adds the four roles and drops no column or row', async () => {
    const sql = await statements('0013_native_shapes.sql')
    for (const column of ['input', 'output', 'reference', 'metadata']) {
      expect(sql).toContain(`ADD COLUMN "${column}" jsonb`)
    }
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bDELETE\b|\bTRUNCATE\b/i)
  })

  test('the backfill maps each retired column to the role that replaced it', async () => {
    const sql = await statements('0013_native_shapes.sql')
    // `to_jsonb(artifact)` and not a cast: a legacy artifact was text, so it becomes a JSON
    // STRING — never parsed, even when it happens to look like JSON.
    expect(sql).toContain('SET "output" = to_jsonb("artifact"), "reference" = "context"')
    // Guarded, so it touched only rows written before it and re-running it changes nothing.
    expect(sql).toContain('WHERE "output" IS NULL')
    // `input` and `metadata` are absent from the backfill on purpose: a pre-0073 trace never
    // recorded either, and inventing one from `context` would be a guess stored as a fact.
    expect(sql).not.toContain('"input" =')
    expect(sql).not.toContain('"metadata" =')
  })
})

describe('0014 contracts, and only after the copy', () => {
  test('it drops exactly the two retired columns, and deletes no row', async () => {
    const sql = await statements('0014_drop_artifact_context.sql')
    expect(sql).toContain('DROP COLUMN "artifact"')
    expect(sql).toContain('DROP COLUMN "context"')
    expect(sql).toMatch(/DROP COLUMN/g)
    expect(sql.match(/DROP COLUMN/g)).toHaveLength(2)
    expect(sql).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|\bDROP\s+TABLE\b/i)
  })

  test('`output` becomes NOT NULL — the constraint the backfill earned', async () => {
    const sql = await statements('0014_drop_artifact_context.sql')
    expect(sql).toContain('ALTER COLUMN "output" SET NOT NULL')
    // And `input` stays nullable: the legacy rows are still legacy, for good.
    expect(sql).not.toContain('"input" SET NOT NULL')
  })

  test('the drop comes AFTER the migration that copied the data out', async () => {
    const names: string[] = []
    for await (const file of new Glob('*.sql').scan({ cwd: MIGRATIONS })) names.push(file)
    const backfill = names.find((name) => name.startsWith('0013'))
    const drop = names.find((name) => name.startsWith('0014'))
    expect(backfill).toBeDefined()
    expect(drop).toBeDefined()
    expect((backfill ?? '') < (drop ?? '')).toBe(true)
  })
})
