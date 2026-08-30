import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { createSqlClient } from './sql-client.ts'

/**
 * Runs the forward-only migration stream as the MIGRATOR role. The app role holds no DDL
 * and so cannot do this — which is the point: a running API physically cannot alter its
 * own schema, whatever a bug or an injected statement asks it to.
 *
 * Migrations run as a deliberate step (a compose one-shot, a deploy step, `bun run
 * db:migrate`), never on application boot. An API that migrates at startup migrates once
 * per replica, races itself, and turns a bad migration into a total outage instead of a
 * failed deploy.
 */

export const MIGRATIONS_FOLDER = new URL('../migrations', import.meta.url).pathname

export const runMigrations = async (migrationUrl: string): Promise<void> => {
  const client = createSqlClient({ url: migrationUrl, max: 1 })
  try {
    await migrate(drizzle({ client: client.pool }), { migrationsFolder: MIGRATIONS_FOLDER })
  } finally {
    await client.close()
  }
}
