#!/usr/bin/env bun
import { installQueueSchema, runMigrations } from '@labelloop/db'
import { requireEnv } from './env.ts'

/**
 * Applies the forward-only migration stream as the migrator role. Never runs on
 * application boot: an API that migrates at startup migrates once per replica, races
 * itself, and turns a bad migration into an outage rather than a failed deploy.
 *
 * The queue's schema is installed in the same step and by the same role. pg-boss would
 * install it for itself the first time the API started, which is precisely what the
 * migrator/app split exists to prevent — the app role holds DML and nothing else, so the
 * one process that must never be able to write DDL is the one that would be doing it.
 */

const migrationUrl = requireEnv('DATABASE_MIGRATION_URL')

await runMigrations(migrationUrl)
console.log('migrations applied')

await installQueueSchema(migrationUrl)
console.log('queue schema installed')
