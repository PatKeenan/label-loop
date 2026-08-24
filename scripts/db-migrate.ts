#!/usr/bin/env bun
import { runMigrations } from '@labelloop/db'
import { requireEnv } from './env.ts'

/**
 * Applies the forward-only migration stream as the migrator role. Never runs on
 * application boot: an API that migrates at startup migrates once per replica, races
 * itself, and turns a bad migration into an outage rather than a failed deploy.
 */

await runMigrations(requireEnv('DATABASE_MIGRATION_URL'))
console.log('migrations applied')
