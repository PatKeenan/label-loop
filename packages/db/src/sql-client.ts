import { Pool } from 'pg'

/**
 * The raw SQL client, over `node-postgres` (ADR-0031).
 *
 * **Why this thin layer exists at all.** The repo reads SQL as tagged templates in about
 * sixty-five places, most of them the database tests that are the safety net for the
 * driver swap itself. Rewriting every one of them by hand to `pool.query(text, values)`
 * would put the risk in sixty-five edits instead of one file — and the edits would be to
 * the very assertions meant to catch a mistake. So the call sites keep their shape and the
 * driver changes underneath them.
 *
 * It is deliberately NOT a query builder and not an abstraction over Postgres. It is four
 * things: a tagged template, `unsafe` for statements with no parameters, `close`, and the
 * underlying pool for Drizzle. Anything richer belongs in the query builder.
 *
 * **The one security-relevant function is `buildQuery`.** It is exported solely so the
 * injection guard can assert on the text it produces rather than infer it from behaviour. Interpolated values would be a SQL
 * injection, so the template's expressions never reach the query text — they become
 * `$1..$n` placeholders and travel in the values array. There is a test that plants a
 * `DROP TABLE` in a value and proves the table survives.
 */

export type SqlRow = Record<string, unknown>

const IDENTIFIER = Symbol('sql.identifier')

type Identifier = { readonly [IDENTIFIER]: string }

const isIdentifier = (value: unknown): value is Identifier =>
  typeof value === 'object' && value !== null && IDENTIFIER in value

/**
 * A table or column name, which cannot be a bound parameter — Postgres will not accept
 * `FROM $1`. So it is inlined, and therefore quoted: doubling any embedded quote is what
 * stops a name from closing its own identifier and becoming SQL.
 *
 * **Split on dots first.** A schema-qualified name is two identifiers, and quoting it whole
 * produces `"drizzle.__drizzle_migrations"` — a single table whose name contains a dot, in
 * the default schema, which does not exist. That is not hypothetical: it is how `/readyz`
 * broke on the driver swap, silently enough that only the composed stack caught it.
 *
 * The trade is that a name containing a literal dot cannot be expressed. Schema
 * qualification is overwhelmingly the commoner case, and it is the trade the previous
 * driver made too.
 */
const quoteIdentifier = (name: string): string =>
  name
    .split('.')
    .map((part) => `"${part.replaceAll('"', '""')}"`)
    .join('.')

export type SqlClient = {
  <T = SqlRow>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  /** Escape an identifier for interpolation: `` sql`SELECT * FROM ${sql(table)}` ``. */
  (identifier: string): Identifier
  /**
   * A statement built as text — DDL, a migration file, a `GRANT` naming a role. Named
   * `unsafe` because the caller owns the string, exactly as the previous driver named it.
   */
  unsafe: <T = SqlRow>(text: string, params?: unknown[]) => Promise<T[]>
  close: () => Promise<void>
  /** The pool Drizzle is handed. Exposed so there is one connection pool, not two. */
  pool: Pool
}

/**
 * Build the query text and the values array together.
 *
 * The placeholder number is the PARAMETER's position, not the expression's, because an
 * escaped identifier is inlined and consumes no placeholder. Deriving `$n` from the loop
 * index instead would silently misnumber every parameter after the first identifier — the
 * kind of bug that produces a working query with the wrong values in it.
 */
export const buildQuery = (
  strings: TemplateStringsArray,
  values: unknown[],
): { text: string; params: unknown[] } => {
  let text = strings[0] ?? ''
  const params: unknown[] = []
  for (const [index, value] of values.entries()) {
    if (isIdentifier(value)) {
      text += quoteIdentifier(value[IDENTIFIER])
    } else {
      params.push(value)
      text += `$${params.length}`
    }
    text += strings[index + 1] ?? ''
  }
  return { text, params }
}

export type SqlClientOptions = {
  url: string
  /** Bounded on purpose: an unbounded pool turns a slow query into a connection storm. */
  max?: number
}

export const createSqlClient = ({ url, max = 10 }: SqlClientOptions): SqlClient => {
  const pool = new Pool({ connectionString: url, max })

  const client = ((
    stringsOrIdentifier: TemplateStringsArray | string,
    ...values: unknown[]
  ): Promise<SqlRow[]> | Identifier => {
    if (typeof stringsOrIdentifier === 'string') {
      return { [IDENTIFIER]: stringsOrIdentifier }
    }
    const { text, params } = buildQuery(stringsOrIdentifier, values)
    return pool.query(text, params).then((result) => result.rows as SqlRow[])
  }) as SqlClient

  client.unsafe = async <T = SqlRow>(text: string, params: unknown[] = []): Promise<T[]> => {
    const result = await pool.query(text, params)
    return result.rows as T[]
  }
  client.close = () => pool.end()
  client.pool = pool

  return client
}
