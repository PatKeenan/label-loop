#!/usr/bin/env bun
import { bootstrapRoles } from '@labelloop/db'
import { requireEnv } from './env.ts'

/**
 * Creates the two database roles. The ONLY step that needs a superuser, which is why it
 * is its own command rather than a phase of `db:migrate` — a migration script holding
 * superuser credentials would make the migrator/app privilege split decorative.
 *
 * Idempotent: safe on every `db:setup`, on every fresh CI database, and as the way to
 * rotate a role's password (change the connection string, re-run this).
 */

const adminUrl = requireEnv('DATABASE_ADMIN_URL')
const appUrl = requireEnv('DATABASE_URL')
const migrationUrl = requireEnv('DATABASE_MIGRATION_URL')

await bootstrapRoles({ adminUrl, appUrl, migrationUrl })
console.log('roles ready: labelloop_migrator (DDL), labelloop_app (DML only)')
