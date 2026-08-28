import { SQL } from 'bun'

/**
 * Connections for the database-backed tests.
 *
 * These tests deliberately do NOT skip when there is no database. The append-only
 * guarantee and the migrator/app privilege split are the two claims this package exists
 * to make, and a claim whose test silently skips is weaker than one with no test at all —
 * it reads green in CI while proving nothing. Missing configuration fails loudly and says
 * how to fix it.
 */

const required = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set — the database tests need a running Postgres.\n` +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return value
}

/** The role the API connects with: DML only, no DDL, no UPDATE/DELETE on audit_events. */
export const appClient = () => new SQL({ url: required('DATABASE_URL'), max: 2 })

/** The role that owns the schema. Used only to set up fixtures a test then acts on. */
export const migratorClient = () => new SQL({ url: required('DATABASE_MIGRATION_URL'), max: 2 })

/** A Postgres error code (`42501` = insufficient_privilege), for asserting on the cause. */
export const errnoOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'errno' in error
    ? String((error as { errno: unknown }).errno)
    : undefined
