import { migrationStatus } from '@labelloop/db'
import { Hono } from 'hono'
import type { AppDeps, AppEnv } from '../app-env.ts'

/**
 * Liveness and readiness, which answer different questions and must not be conflated
 * (CONVENTIONS.md "Health & lifecycle").
 *
 * `/healthz` asks only "is this process up" and touches NO dependency — if it checked the
 * database, a Postgres blip would get every container killed and restarted, turning a
 * recoverable outage into a thundering herd. It also reports which build it is (ADR-0011).
 *
 * `/readyz` asks "should traffic be sent here" and does check dependencies. Compose and
 * deploys gate on it.
 */

/** A dependency check has to fail fast: a hanging probe is a hung orchestrator. */
const CHECK_TIMEOUT_MS = 2_000

type Check = { name: string; ok: boolean; detail?: string }

const withTimeout = async <T>(work: Promise<T>, name: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${name} check timed out`)), CHECK_TIMEOUT_MS)
  })
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const describeFailure = (error: unknown): string =>
  error instanceof Error ? error.message : 'unknown error'

const checkDatabase = async (deps: AppDeps): Promise<Check> => {
  try {
    await withTimeout(deps.db.client`SELECT 1`, 'database')
    return { name: 'database', ok: true }
  } catch (error) {
    return { name: 'database', ok: false, detail: describeFailure(error) }
  }
}

/**
 * Reachability is not readiness. A container running last release's code against this
 * release's schema is up and answering, and answering wrongly — which is exactly what a
 * rolling deploy produces if nothing checks. It reports being behind and being AHEAD
 * separately, because an old image rolled onto a new schema is a different incident.
 */
const checkMigrations = async (deps: AppDeps): Promise<Check> => {
  try {
    const status = await withTimeout(migrationStatus(deps.db.client), 'migrations')
    return status.current
      ? { name: 'migrations', ok: true }
      : { name: 'migrations', ok: false, detail: status.reason }
  } catch (error) {
    return { name: 'migrations', ok: false, detail: describeFailure(error) }
  }
}

export const createHealthRoutes = () => {
  const startedAt = Date.now()

  return new Hono<AppEnv>()
    .get('/healthz', (c) => {
      const { config } = c.var.deps
      return c.json({
        data: {
          status: 'ok' as const,
          version: config.APP_VERSION,
          git_sha: config.GIT_SHA,
          uptime_s: Math.floor((Date.now() - startedAt) / 1000),
        },
        request_id: c.var.requestId,
      })
    })
    .get('/readyz', async (c) => {
      const deps = c.var.deps
      // Concurrently: the probe's latency is the slowest check, not their sum. P5 adds the
      // queue to this list.
      const checks = await Promise.all([checkDatabase(deps), checkMigrations(deps)])
      const ready = checks.every((check) => check.ok)

      if (!ready) {
        c.var.logger.warn({ checks: checks.filter((check) => !check.ok) }, 'readiness check failed')
      }

      // Deliberately the SUCCESS envelope with a 503, not an error envelope. An unready
      // process is not a caller error and no code in the taxonomy describes it — the body
      // is a status report whose value is naming the failing check, and the status code is
      // the part an orchestrator reads.
      return c.json(
        {
          data: { status: ready ? ('ready' as const) : ('unready' as const), checks },
          request_id: c.var.requestId,
        },
        ready ? 200 : 503,
      )
    })
}
