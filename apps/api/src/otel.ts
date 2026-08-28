import {
  context,
  type DiagLogger,
  DiagLogLevel,
  diag,
  propagation,
  type Tracer,
  trace,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { setGlobalErrorHandler, W3CTraceContextPropagator } from '@opentelemetry/core'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import { type Config, SERVICE_NAME } from './config.ts'

/**
 * The OpenTelemetry SDK, assembled by hand.
 *
 * **No auto-instrumentation, anywhere** (ADR-0007). Bun's auto-instrumentation is patchier
 * than Node's, and the more interesting reason is that a span nobody wrote is a span
 * nobody chose: this codebase emits exactly two kinds — one per HTTP request
 * (`middleware/tracing.ts`) and one per provider call (`llm/`) — and every attribute on
 * them is deliberate. `architecture.test.ts` asserts that no auto-instrumentation package
 * is imported anywhere, so the rule survives the next person who wants a quick win.
 *
 * **`BasicTracerProvider`, not `NodeTracerProvider`.** The Node provider's job is to pick
 * a context manager and a propagator on your behalf; both are named explicitly below
 * instead, and the package that would drag auto-instrumentation along is simply absent.
 *
 * **Exporting is optional; tracing is not.** Without `OTEL_EXPORTER_OTLP_ENDPOINT` the
 * provider still runs and still mints real W3C trace ids — which matters, because
 * `request_id` IS the active span's trace id (ADR-0010), so a boot with no collector must
 * still put an honest id on every response. An unset endpoint removes the exporter, not
 * the tracing.
 */

/** How many finished spans may wait to be exported before new ones are DROPPED. */
const MAX_QUEUE_SIZE = 2_048
/** How long a batch waits to fill before it is sent anyway. */
const SCHEDULED_DELAY_MS = 5_000
/** A slow collector must not become our latency; the export is abandoned instead. */
const EXPORT_TIMEOUT_MS = 30_000

export type Telemetry = {
  /** The tracer the app's spans come from. Injected at composition, never reached for. */
  tracer: Tracer
  /** True when spans are actually going somewhere. False is a supported state. */
  exporting: boolean
  /** Push what is buffered right now. Used by tests; shutdown uses `shutdown()`. */
  forceFlush: () => Promise<void>
  /** Flush and stop. Called during graceful shutdown, before the process exits. */
  shutdown: () => Promise<void>
}

/**
 * Identity carried by every span in the process, attached once as a Resource rather than
 * per-span — which is how OTLP represents "true of all of these", and why
 * `service.version` on every span (ADR-0011) costs nothing per span to guarantee.
 */
const resourceFor = (config: Config) =>
  resourceFromAttributes({
    [ATTR_SERVICE_NAME]: SERVICE_NAME,
    // The chain ADR-0011 describes ends here: release-please → package.json → build arg →
    // config → this attribute. It is what makes "p95 regressed after v0.4.0" a query.
    [ATTR_SERVICE_VERSION]: config.APP_VERSION,
    // Incubating in semconv 1.43, so it is spelled out rather than imported from a module
    // whose exports are explicitly unstable.
    'deployment.environment.name': config.NODE_ENV,
    // No stable convention names a build's commit. Namespaced so it cannot collide with
    // one that arrives later, and matching the `git_sha` the log lines already carry.
    'labelloop.git_sha': config.GIT_SHA,
  })

/**
 * Build a tracer provider without touching any process global.
 *
 * Separate from `startTelemetry` on purpose: a test can stand a real provider up against a
 * real OTLP endpoint and assert on the bytes it sends, while the process globals — which
 * may only be set once, and would leak between test files — stay untouched.
 */
export const createTelemetry = (config: Config): Telemetry & { provider: BasicTracerProvider } => {
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT

  const provider = new BasicTracerProvider({
    resource: resourceFor(config),
    // ADR-0001 captures 100% of judge calls, so a sampler that threw requests away would
    // be arguing with it. Volume is bounded by the queue below instead, and sampling
    // becomes an M2 question once the load test has said what the volume actually is.
    sampler: new AlwaysOnSampler(),
    spanProcessors:
      endpoint === undefined
        ? []
        : [
            new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }), {
              // Bounded and drop-on-full, which is the whole point: an observability
              // backend that is slow or gone must degrade telemetry, never the request
              // path, and never by growing a queue until the process dies. Dropping spans
              // is the correct failure here — the same principle that bans pino transports
              // (CONVENTIONS.md "Logging").
              maxQueueSize: MAX_QUEUE_SIZE,
              scheduledDelayMillis: SCHEDULED_DELAY_MS,
              exportTimeoutMillis: EXPORT_TIMEOUT_MS,
            }),
          ],
  })

  return {
    provider,
    tracer: provider.getTracer(SERVICE_NAME, config.APP_VERSION),
    exporting: endpoint !== undefined,
    forceFlush: () => provider.forceFlush(),
    shutdown: () => provider.shutdown(),
  }
}

/** The subset of the logger `diag` needs. Structural, so pino satisfies it. */
export type DiagSink = {
  error: (obj: object, msg: string) => void
  warn: (obj: object, msg: string) => void
  info: (obj: object, msg: string) => void
  debug: (obj: object, msg: string) => void
}

const diagLogger = (sink: DiagSink): DiagLogger => {
  const at =
    (write: (obj: object, msg: string) => void) =>
    (message: string, ...args: unknown[]) =>
      write({ component: 'otel', ...(args.length === 0 ? {} : { detail: args }) }, message)
  return {
    error: at(sink.error),
    warn: at(sink.warn),
    info: at(sink.info),
    debug: at(sink.debug),
    verbose: at(sink.debug),
  }
}

/**
 * Install the SDK into the process: context manager, propagator, tracer provider, and TWO
 * separate failure bridges. Called once, from `server.ts`, before anything that might trace.
 *
 * The bridges are not decoration, and there are two of them because OpenTelemetry has two
 * unrelated failure channels — which is a trap, and one this codebase walked into before
 * finding it by unplugging the collector and watching absolutely nothing happen:
 *
 * - `diag` is the SDK's own diagnostics, and its default logger discards everything.
 * - the **global error handler** is what a span processor calls when an EXPORT fails.
 *   `BatchSpanProcessor` reports there, not through `diag`, so a bridge on `diag` alone
 *   leaves the single most likely failure — the collector is unreachable — completely
 *   silent, and "no traces in Grafana" becomes indistinguishable from "no traffic".
 *
 * Both land on the same logger at `warn`, which is what the level means here: degraded but
 * serving. Losing spans must never be an `error` that pages someone, and must never be
 * nothing at all.
 */
export const startTelemetry = (config: Config, sink: DiagSink): Telemetry => {
  diag.setLogger(diagLogger(sink), DiagLogLevel.WARN)
  setGlobalErrorHandler((error) => {
    sink.warn(
      { component: 'otel', err: error instanceof Error ? error : new Error(String(error)) },
      'span export failed — traces are being dropped',
    )
  })

  // Node's AsyncLocalStorage, which Bun implements. This is what makes `getActiveSpan()`
  // still return the request's span after an `await` — and therefore what makes the
  // `request_id`, the log lines and the spans agree by construction rather than by being
  // threaded through every signature.
  const contextManager = new AsyncLocalStorageContextManager()
  contextManager.enable()
  context.setGlobalContextManager(contextManager)

  // Registered for OUTBOUND propagation — a `traceparent` on calls we make. Inbound
  // extraction is deliberately absent; `middleware/tracing.ts` says why the public edge
  // mints its own trace id rather than adopting a caller's.
  propagation.setGlobalPropagator(new W3CTraceContextPropagator())

  const { provider, ...telemetry } = createTelemetry(config)
  // Registered even though every call site is injected, so that any library reaching for
  // the global API sees this provider rather than standing up a second, invisible one.
  trace.setGlobalTracerProvider(provider)

  return telemetry
}
