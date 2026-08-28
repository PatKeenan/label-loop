import { trace } from '@opentelemetry/api'
import { createErrorReporter } from '../adapters/sentry-error-reporter.ts'
import { loadConfig } from '../config.ts'
import { startTelemetry } from '../otel.ts'

/**
 * A probe, run as a SUBPROCESS by `otel.test.ts`, that answers one question: does loading
 * the Sentry SDK take the OpenTelemetry tracer provider away from us?
 *
 * It exists as its own process because both SDKs write to per-process globals that may be
 * set exactly once. Asking this question in-process would leave `@sentry/bun` loaded and a
 * global tracer provider registered for every test file that ran afterwards — the answer
 * would be trustworthy and the suite around it would not.
 *
 * The order here is the order `server.ts` uses, deliberately: telemetry first, then the
 * error reporter. The whole point is to prove that ordering is belt-and-braces rather than
 * the thing holding it together.
 */
const silent = { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }

const config = loadConfig()
startTelemetry(config, silent)
const before = trace.getTracerProvider()

// The real adapter, not a direct `Sentry.init` — what is under test is the code that
// actually runs in production, including `initWithoutDefaultIntegrations` (ADR-0007).
await createErrorReporter(config)
const after = trace.getTracerProvider()

const span = trace.getTracer('probe').startSpan('probe')
process.stdout.write(
  JSON.stringify({
    sameProvider: before === after,
    recording: span.isRecording(),
    traceId: span.spanContext().traceId,
  }),
)
span.end()
