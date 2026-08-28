import type { Context, MiddlewareHandler } from 'hono'
import { pinoLogger } from 'hono-pino'
import { type DestinationStream, type LoggerOptions, pino } from 'pino'
import { type Config, SERVICE_NAME } from '../config.ts'
import { REQUEST_ID_KEY } from './request-context.ts'

/**
 * One structured JSON logger for the whole process (CONVENTIONS.md "Logging").
 *
 * **Zero transports, ever.** pino writes raw NDJSON to stdout and nothing else: an
 * in-process transport couples API availability to the log backend, buffers unboundedly
 * when that backend is slow, and loses everything buffered on a crash. Aggregation is
 * out-of-process — the OTel Collector's filelog receiver reads container stdout (M3,
 * ADR-0007 amendment). Pretty-printing in dev is a pipe: `bun run dev | pino-pretty`.
 */
export const createRootLogger = (config: Config, destination?: DestinationStream) => {
  const options = {
    level: config.LOG_LEVEL,
    // `base: null` drops pino's default pid/hostname — neither is meaningful in a
    // container — and, more importantly, leaves the logger with no bindings for
    // hono-pino to copy. It seeds its per-request child from `rootLogger.bindings()`
    // while that child already inherits them, so anything in `base` is emitted TWICE on
    // every request line. `mixin` puts the same fields on every line without being
    // bindings, which sidesteps the duplication entirely.
    base: null,
    mixin: () => ({
      // The same constant OTel's `service.name` resource attribute uses, so a log line and
      // a span name the same service and the Grafana join between them holds.
      service: SERVICE_NAME,
      // On every line, so "which build logged this" is never a guess (ADR-0011).
      version: config.APP_VERSION,
      git_sha: config.GIT_SHA,
      env: config.NODE_ENV,
    }),
    // ISO-8601 UTC, matching the timestamp convention everywhere else.
    timestamp: pino.stdTimeFunctions.isoTime,
  } satisfies LoggerOptions

  // Only tests pass a destination. Production writes to pino's default, which is stdout
  // — never a transport (see above).
  return destination === undefined ? pino(options) : pino(options, destination)
}

export type RootLogger = ReturnType<typeof createRootLogger>

/**
 * Request/response bindings. Note what is absent: **no headers and no bodies**.
 * hono-pino's defaults log `c.req.header()` wholesale, which would put every
 * `Authorization: Bearer llk_live_…` into the log stream. Bodies are never logged at all
 * — payloads live in the access-controlled `traces` table, not in log storage.
 */
const requestBindings = (c: Context) => ({
  request_id: c.get(REQUEST_ID_KEY),
  req: { method: c.req.method, path: c.req.path },
})

export const httpLogger = (logger: RootLogger): MiddlewareHandler =>
  pinoLogger({
    pino: logger,
    http: {
      // Our own id from `request-context.ts`; hono-pino's counter would be a second,
      // conflicting identity for the same execution.
      reqId: false,
      // hono-pino defaults this to "requestId" — which IS our context key — and would
      // then emit the same value a second time as `reqId`. Pointing it at a key that
      // does not exist leaves `request_id` as the one spelling, matching the envelope.
      referRequestIdKey: '__request_id_is_bound_explicitly__',
      onReqBindings: requestBindings,
      onResBindings: (c) => ({ res: { status: c.res.status } }),
      // A stable message with the status in a field, rather than hono-pino's default of
      // using the thrown error's text — log lines are grepped by `msg`, so it should
      // name the event, not vary per failure.
      onResMessage: () => 'request completed',
      onResLevel: (c) => (c.res.status >= 500 ? 'error' : c.res.status >= 400 ? 'warn' : 'info'),
    },
  })
