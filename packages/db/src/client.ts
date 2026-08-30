import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema/index.ts'
import { createSqlClient } from './sql-client.ts'

/**
 * The database handle the API connects with, over `node-postgres` (ADR-0031).
 *
 * It used to run on Bun's native driver, on the reasoning that the driver was then the
 * runtime rather than a dependency. Two things retired that: `pg` is already in the tree
 * via pg-boss, so nothing was actually saved; and the Drizzle + Bun-SQL pairing silently
 * double-encoded jsonb twice in one afternoon.
 *
 * It is created here and injected through `createApp(deps)`; nothing imports a live
 * connection ad hoc.
 */

export type Database = ReturnType<typeof createDatabase>

export type DatabaseOptions = {
  url: string
  /** Bounded on purpose: an unbounded pool turns a slow query into a connection storm. */
  max?: number
}

export const createDatabase = ({ url, max = 10 }: DatabaseOptions) => {
  const client = createSqlClient({ url, max })
  // Drizzle takes the POOL and the raw client shares it, so there is one pool per handle
  // rather than two competing for the same bounded connection budget.
  return Object.assign(drizzle({ client: client.pool, schema }), {
    /** Closes the pool. Called by the shutdown path, after in-flight work has drained. */
    close: () => client.close(),
    /** The raw client, for the health check and for SQL no query builder should own. */
    client,
  })
}
