import { Hono } from 'hono'
import type { AppEnv } from '../app-env.ts'

/**
 * Liveness (CONVENTIONS.md "Health & lifecycle"). `/healthz` answers one question — is
 * this process up — and must never touch a dependency, or a database blip would get the
 * container killed rather than merely marked unready. `/readyz` is the one that checks
 * dependencies, and it arrives at P3 when there is a database to check.
 *
 * It also reports which build it is (ADR-0011): `curl /healthz` is the end of the chain
 * that starts at a release-please version and passes through a container build arg.
 */
export const createHealthRoutes = () => {
  const startedAt = Date.now()

  return new Hono<AppEnv>().get('/healthz', (c) => {
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
}
