import type { SQL } from 'bun'
import journal from '../migrations/meta/_journal.json' with { type: 'json' }

/**
 * "Are the migrations current?" — the second half of `/readyz` (CONVENTIONS.md "Health &
 * lifecycle"). Reachability alone is not readiness: a container running last release's
 * code against this release's schema is *up* and serving wrong answers, which is exactly
 * what a rolling deploy produces if nothing checks.
 *
 * Drizzle records one row per applied migration, stamped with the `when` from the journal
 * that generated it. Comparing the newest applied stamp to the newest journal entry
 * answers the question without re-reading every migration file.
 */

const MIGRATIONS_TABLE = 'drizzle.__drizzle_migrations'

export type MigrationStatus =
  | { current: true; applied: number; expected: number }
  | { current: false; applied: number; expected: number; reason: string }

const latestJournalEntry = () => {
  const entries = journal.entries
  return entries.length === 0 ? undefined : entries[entries.length - 1]
}

/**
 * What this build expects to find applied. Exported so a test double can report being
 * current without hard-coding numbers that go stale the next time a migration is added.
 */
export const expectedMigrations = (): { count: number; newest: number } => ({
  count: journal.entries.length,
  newest: latestJournalEntry()?.when ?? 0,
})

export const migrationStatus = async (client: SQL): Promise<MigrationStatus> => {
  const expected = journal.entries.length
  const latest = latestJournalEntry()

  const rows = (await client`
    SELECT count(*)::int AS applied, coalesce(max(created_at), 0)::bigint AS newest
    FROM ${client(MIGRATIONS_TABLE)}
  `) as Array<{ applied: number; newest: string | number }>

  const row = rows[0]
  if (row === undefined) {
    return { current: false, applied: 0, expected, reason: 'migration table is unreadable' }
  }

  const applied = row.applied
  if (applied < expected) {
    return {
      current: false,
      applied,
      expected,
      reason: `${expected - applied} migration(s) not applied — run db:migrate`,
    }
  }
  // More applied than this build knows about means the database is AHEAD: an older image
  // rolled back onto a newer schema. Not ready, and a different problem from being behind.
  if (applied > expected) {
    return {
      current: false,
      applied,
      expected,
      reason: 'database is ahead of this build — it was migrated by a newer release',
    }
  }
  if (latest !== undefined && Number(row.newest) !== latest.when) {
    return {
      current: false,
      applied,
      expected,
      reason: 'applied migrations do not match this build’s migration history',
    }
  }
  return { current: true, applied, expected }
}
