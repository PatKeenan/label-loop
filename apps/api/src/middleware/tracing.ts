import {
  type Attributes,
  context,
  type Meter,
  SpanKind,
  SpanStatusCode,
  type Tracer,
  trace,
} from '@opentelemetry/api'
import {
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_URL_PATH,
  ATTR_URL_SCHEME,
} from '@opentelemetry/semantic-conventions'
import type { MiddlewareHandler } from 'hono'
import { ATTR_STATUS_CLASS, instrumentsFor, statusClass } from '../metrics.ts'

/**
 * One span per HTTP request, written by hand (ADR-0007). It is the root of every trace
 * this service produces, and — because `request-context.ts` reads its trace id — it is
 * also where `request_id` comes from, which is why it must run before everything else.
 *
 * **The public edge does NOT adopt an inbound `traceparent`.** The W3C propagator is
 * registered (`otel.ts`) so we can *send* context; extracting it here would be the
 * conventional distributed-tracing move and is deliberately not made, because ADR-0010
 * gives `request_id` two jobs an untrusted caller would break. It names ONE execution —
 * a client that replays one `traceparent` across a thousand calls would collapse a
 * thousand executions onto one id, and `traces.request_id` would stop joining to anything
 * — and it is "the id a customer quotes to support", which has to be an id we minted and
 * can find. When a first-party caller exists whose context is worth continuing, the
 * propagator is already installed and extraction is one line, gated on trust.
 */

/**
 * Hono's placeholder for "no route matched". Excluded rather than recorded: `http.route`
 * is meant to be the low-cardinality template a metric can group by, and a 404's route is
 * not a route at all.
 *
 * It is the METRIC label as well now, and this is where the rule earns its keep: labelling
 * a series with `c.req.path` would mint one time series per URL a stranger on the internet
 * decided to try. Unmatched requests are counted under this single bucket instead, so a
 * 404 flood costs one series rather than as many as the flood has imagination.
 */
const UNMATCHED = '/*'

export const tracing = (tracer: Tracer, meter: Meter): MiddlewareHandler => {
  // Built once, at composition, rather than per request: `createCounter` on every request
  // would allocate an instrument object per request to reach an aggregation the SDK has
  // already keyed by name.
  const { httpDuration, httpRequests } = instrumentsFor(meter)

  return async (c, next) => {
    const span = tracer.startSpan(c.req.method, {
      // We are the server end of a remote call. The kind is what makes Tempo draw this as
      // the entry point rather than as an internal step.
      kind: SpanKind.SERVER,
      attributes: {
        [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
        // The PATH only — never the query string, never headers, never the body. A query
        // string is caller-supplied text and can carry PII, and CONVENTIONS' "log metadata,
        // not content" is a rule about telemetry, not about pino specifically.
        [ATTR_URL_PATH]: c.req.path,
        [ATTR_URL_SCHEME]: new URL(c.req.url).protocol.replace(':', ''),
      },
    })
    // Monotonic, and deliberately not the injected `Clock`. That port exists so backoff
    // and breaker windows can be asserted against a fixed time; a latency histogram wants
    // real elapsed time and would be measuring the fake if it read the same source.
    const startedAt = performance.now()

    await context.with(trace.setSpan(context.active(), span), async () => {
      try {
        // Hono runs `onError` and `notFound` INSIDE the middleware chain, so by the time
        // this resolves `c.res` already holds the final response — including the 500 the
        // central error handler built. That is verified by this middleware's own test,
        // because it is the assumption the whole `finally` block rests on.
        await next()
      } catch (error) {
        // Only reachable if the error handler itself threw. The span still has to say what
        // happened, and the error still has to reach `app.onError`.
        span.recordException(error instanceof Error ? error : new Error(String(error)))
        span.setStatus({ code: SpanStatusCode.ERROR })
        throw error
      } finally {
        // Resolved by the router during `next()`, so it can only be read afterwards.
        const route = c.req.routePath
        if (route !== UNMATCHED) {
          span.setAttribute(ATTR_HTTP_ROUTE, route)
          // `METHOD /v1/panels/{panel_id}/evaluate`, not `METHOD /v1/panels/pnl_01.../evaluate`.
          // The span NAME is what a trace list groups by, so putting an id in it would give
          // every request its own row and make the list useless.
          span.updateName(`${c.req.method} ${route}`)
        }
        const status = c.res?.status
        if (status !== undefined) {
          span.setAttribute(ATTR_HTTP_RESPONSE_STATUS_CODE, status)
          // Only 5xx is an error for a SERVER span, per the HTTP semantic conventions: a 401
          // or a 422 is the API working correctly and telling a caller they got it wrong.
          // Marking those red would drown the ones that mean something.
          if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR })
        }

        // **This `finally` is the metric funnel too** — the same reason it is the span's.
        // Every request leaves through here, including the ones the error handler turned
        // into a 500 and the ones that never matched a route, so there is one place to
        // forget rather than five.
        //
        // THREE labels, and no fourth. Route template, method and status CLASS are each
        // bounded by things this codebase controls; a status code would be five times the
        // series to answer the same question, and anything identifying a caller is banned
        // outright (ADR-0042) — per-key usage is a SQL query, not a label.
        const labels: Attributes = {
          // `route` is already `UNMATCHED` when nothing matched, which is the bucket the
          // constant's comment describes — recorded rather than dropped, because "how many
          // 404s" is a real question and one series is a fine price for it.
          [ATTR_HTTP_ROUTE]: route,
          [ATTR_HTTP_REQUEST_METHOD]: c.req.method,
          ...(status === undefined ? {} : { [ATTR_STATUS_CLASS]: statusClass(status) }),
        }
        // Seconds, per the HTTP semantic convention this histogram is named for, and what
        // `histogram_quantile` in a Grafana panel expects to be handed.
        httpDuration.record((performance.now() - startedAt) / 1_000, labels)
        httpRequests.add(1, labels)

        span.end()
      }
    })
  }
}
