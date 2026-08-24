import { defineConfig } from 'drizzle-kit'

/**
 * Forward-only, always (CONVENTIONS.md "Repo shape"). drizzle-kit never generates a down
 * migration and none is written by hand: rolling a schema backwards in production is a
 * fiction that costs more than it saves, and the recovery path is a new forward migration.
 *
 * Generation is a local, deliberate act (`bun run db:generate`) whose output is committed
 * and reviewed. Nothing generates or pushes schema at runtime.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './migrations',
  /** Only ever the migrator: drizzle-kit issues DDL, which the app role cannot. */
  dbCredentials: { url: process.env.DATABASE_MIGRATION_URL ?? '' },
  strict: true,
  verbose: true,
})
