import { SQL } from 'bun'
import { drizzle } from 'drizzle-orm/bun-sql'
import * as schema from './schema/index.ts'

/**
 * The database handle the API connects with, over Bun's native Postgres driver — so the
 * driver is the runtime rather than a dependency, which is one less thing in a tree the
 * CI supply-chain scan has to reason about (CONVENTIONS.md "Dependency threshold").
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
  const client = new SQL({ url, max })
  return Object.assign(drizzle({ client, schema }), {
    /** Closes the pool. Called by the shutdown path, after in-flight work has drained. */
    close: () => client.close(),
    /** The raw client, for the health check and for SQL no query builder should own. */
    client,
  })
}
