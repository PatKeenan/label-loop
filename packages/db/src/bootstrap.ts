import { SQL } from 'bun'
import { APP_ROLE, MIGRATOR_ROLE } from './roles.ts'

/**
 * The one privileged step: creating the two roles. Everything else — tables, grants,
 * default privileges — is done by the migrator in the migration stream, so the surface
 * that needs a superuser is this file and the twenty lines of SQL it runs.
 *
 * Passwords are taken from the connection strings the application already has, rather
 * than from two more environment variables. One source of truth, and bootstrap's job
 * becomes "make the database agree with the config" instead of "keep four values in sync".
 */

const rolesSql = await Bun.file(new URL('../sql/0000_roles.sql', import.meta.url)).text()

/** A Postgres string literal. Doubling the quote is the whole escape — DDL takes no binds. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`

const passwordFrom = (url: string, name: string): string => {
  const password = new URL(url).password
  if (password === '') {
    throw new Error(`${name} has no password — the ${name} role cannot be given one`)
  }
  return decodeURIComponent(password)
}

export type BootstrapOptions = {
  /** A superuser connection. Used for this step only, and never by the running API. */
  adminUrl: string
  /** The app role's connection string; its password becomes the role's password. */
  appUrl: string
  /** The migrator's connection string; likewise. */
  migrationUrl: string
}

export const bootstrapRoles = async ({
  adminUrl,
  appUrl,
  migrationUrl,
}: BootstrapOptions): Promise<void> => {
  const appPassword = passwordFrom(appUrl, 'DATABASE_URL')
  const migratorPassword = passwordFrom(migrationUrl, 'DATABASE_MIGRATION_URL')

  const admin = new SQL({ url: adminUrl, max: 1 })
  try {
    await admin.unsafe(rolesSql)
    // Separate from the SQL file on purpose: it keeps every credential out of a committed
    // file, and it makes rotation a re-run of bootstrap rather than an edit.
    await admin.unsafe(`ALTER ROLE ${MIGRATOR_ROLE} WITH PASSWORD ${literal(migratorPassword)}`)
    await admin.unsafe(`ALTER ROLE ${APP_ROLE} WITH PASSWORD ${literal(appPassword)}`)
  } finally {
    await admin.close()
  }
}
