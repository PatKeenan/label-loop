import { Hono } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'

/**
 * Two synthetic routes, and only two (ADR-0015).
 *
 * BUILD_SPINE requires the error taxonomy demonstrated end to end at M0 — 422, 401, 429
 * and 500. The first two are proven on the *real* classify endpoint at P4, because a
 * malformed body proves contract-validation auto-mapping actually works, whereas a
 * synthetic 422 proves only that a synthetic route can throw. Nothing in M0 legitimately
 * produces a 429 or a 500, so those two get stand-ins.
 *
 * They are mounted **outside `/v1`** and are absent from the OpenAPI document: `/v1` is a
 * versioned public contract, and publishing endpoints there only to delete them at M2
 * would be self-inflicted contract churn. They are deleted at M2 when real rate limiting
 * lands and a 429 has an honest source.
 */
export const createDemoErrorRoutes = () =>
  new Hono<AppEnv>()
    .get('/_demo/rate-limited', () => {
      throw new AppError('RATE_LIMITED', 'Too many requests. Retry after the stated delay.', {
        retryAfterSeconds: 30,
      })
    })
    .get('/_demo/boom', () => {
      // Deliberately NOT an AppError: this proves the unexpected-error path — generic
      // message to the caller, full detail to the reporter.
      throw new Error('synthetic failure from /_demo/boom')
    })
