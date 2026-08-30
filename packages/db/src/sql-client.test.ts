import { afterAll, describe, expect, test } from 'bun:test'
import { buildQuery } from './sql-client.ts'
import { appClient } from './test-support.ts'

/**
 * The driver seam, tested directly — because every other database test now runs through
 * it, so a fault here would look like a fault everywhere else.
 *
 * The parameterisation test is the one that matters. This layer exists to keep sixty-five
 * tagged-template call sites unchanged across a driver swap, and the failure mode of
 * getting it wrong is not a broken test, it is SQL injection in every one of them.
 */

const client = appClient()

afterAll(async () => {
  await client.close()
})

describe('the tagged template', () => {
  test('returns rows, not a driver result object', async () => {
    const rows = await client<{ n: number }>`SELECT 1 AS n`
    expect(rows).toBeArray()
    expect(rows[0]?.n).toBe(1)
  })

  test('numbers the placeholders by position across several values', async () => {
    const rows = await client<{ a: string; b: string; c: number }>`
      SELECT ${'first'}::text AS a, ${'second'}::text AS b, ${3}::int AS c
    `
    expect(rows[0]).toMatchObject({ a: 'first', b: 'second', c: 3 })
  })

  test('PARAMETERISES rather than interpolates — a value cannot become SQL', () => {
    // Asserted on the generated text, not inferred from behaviour: a value that reached
    // the query string would be an injection in all sixty-five call sites at once, and
    // "the database rejected it" is a weaker claim than "it was never SQL".
    const hostile = "'; DROP TABLE orgs; --"
    const { text, params } = buildQuery(
      Object.assign(['SELECT ', '::text AS echoed'], {
        raw: ['SELECT ', '::text AS echoed'],
      }) as unknown as TemplateStringsArray,
      [hostile],
    )
    expect(text).toBe('SELECT $1::text AS echoed')
    expect(text).not.toContain('DROP TABLE')
    expect(params).toEqual([hostile])
  })

  test('and the hostile value round-trips as data, unchanged', async () => {
    const hostile = "'; DROP TABLE orgs; --"
    const rows = await client<{ echoed: string }>`SELECT ${hostile}::text AS echoed`
    expect(rows[0]?.echoed).toBe(hostile)
  })

  test('an escaped IDENTIFIER is inlined and quoted, and does not consume a placeholder', () => {
    const { text, params } = buildQuery(
      Object.assign(['SELECT ', ' FROM ', ' WHERE id = ', ''], {
        raw: ['SELECT ', ' FROM ', ' WHERE id = ', ''],
      }) as unknown as TemplateStringsArray,
      [client('id'), client('orgs'), 'org_1'],
    )
    // The placeholder is $1 despite being the THIRD expression — numbering follows the
    // parameter's position, not the expression's. Getting that wrong would misnumber every
    // parameter after the first identifier and produce a working query with wrong values.
    expect(text).toBe('SELECT "id" FROM "orgs" WHERE id = $1')
    expect(params).toEqual(['org_1'])
  })

  test('a SCHEMA-QUALIFIED identifier is quoted per part, not as one name', () => {
    const { text } = buildQuery(
      Object.assign(['SELECT count(*) FROM ', ''], {
        raw: ['SELECT count(*) FROM ', ''],
      }) as unknown as TemplateStringsArray,
      [client('drizzle.__drizzle_migrations')],
    )
    // `"drizzle"."__drizzle_migrations"`, never `"drizzle.__drizzle_migrations"` — the
    // latter is one table with a dot in its name, in the default schema, and it is how
    // `/readyz` broke on the driver swap.
    expect(text).toBe('SELECT count(*) FROM "drizzle"."__drizzle_migrations"')
  })

  test('an identifier containing a quote cannot close its own identifier', () => {
    const { text } = buildQuery(
      Object.assign(['SELECT * FROM ', ''], {
        raw: ['SELECT * FROM ', ''],
      }) as unknown as TemplateStringsArray,
      [client('we"ird')],
    )
    expect(text).toBe('SELECT * FROM "we""ird"')
  })

  test('a null value is a null parameter, not the text "null"', async () => {
    const rows = await client<{ v: unknown }>`SELECT ${null}::text AS v`
    expect(rows[0]?.v).toBeNull()
  })

  test('an object parameter round-trips as jsonb, which is the bug this swap fixes', async () => {
    const pin = { capabilities: ['structured_outputs'], reasoning: { effort: 'none' } }
    // Both spellings, because under the previous driver the second stored a jsonb STRING
    // and this one stores an object. That asymmetry is what made the defect reachable
    // twice in one afternoon (ADR-0031).
    const [asObject] = await client<{ t: string }>`SELECT jsonb_typeof(${pin}::jsonb) AS t`
    const [asText] = await client<{ t: string }>`
      SELECT jsonb_typeof(${JSON.stringify(pin)}::jsonb) AS t
    `
    expect(asObject?.t).toBe('object')
    expect(asText?.t).toBe('object')
  })

  test('rejects on a bad statement rather than resolving — queries are eager here', async () => {
    // The previous driver returned a LAZY query object, so `expect(q).rejects` never
    // executed it and hung forever. Eager execution is what makes the ordinary matcher work.
    await expect(client`SELECT * FROM a_table_that_does_not_exist`).rejects.toThrow()
  })
})

describe('unsafe', () => {
  test('runs a statement the caller built, and takes parameters when given them', async () => {
    const rows = await createUnsafeProbe()
    expect(rows[0]?.n).toBe(7)
  })
})

const createUnsafeProbe = () => client.unsafe<{ n: number }>('SELECT $1::int AS n', [7])
