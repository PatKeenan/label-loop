import { loadConfig } from '../config.ts'
import { startTelemetry } from '../otel.ts'

/**
 * A probe, run as a SUBPROCESS by `otel.test.ts`, that answers one question: when the
 * collector is unreachable, does anybody find out?
 *
 * The honest answer used to be no, and it was found by unplugging the collector on a
 * running system rather than by reading the code — `BatchSpanProcessor` reports export
 * failures to OpenTelemetry's global ERROR HANDLER, not through `diag`, so a bridge on
 * `diag` alone left the most likely failure in the whole telemetry path completely silent.
 *
 * A subprocess because both bridges are per-process globals that may be set once, and
 * because what is under test is a line arriving on stdout — which is exactly what the
 * production process does with it.
 */
const lines: string[] = []
const sink = {
  // Only the level and the message are recorded. The bound fields carry the underlying
  // error, which is useful to a human and useless to an assertion.
  error: (_fields: object, message: string) => lines.push(`error ${message}`),
  warn: (_fields: object, message: string) => lines.push(`warn ${message}`),
  info: () => {},
  debug: () => {},
}

const config = loadConfig()
const telemetry = startTelemetry(config, sink)

// Enough spans to fill a batch, which is what makes the processor export NOW rather than
// on its five-second timer — the same thing a server under load does, and the only way to
// exercise the scheduled export path inside a test's patience. `forceFlush()` is
// deliberately not used: it rejects on failure and reports through its own promise, so it
// would prove nothing about whether the BACKGROUND failure reaches a human.
for (let index = 0; index < 600; index += 1) telemetry.tracer.startSpan('doomed').end()
await Bun.sleep(400)

process.stdout.write(JSON.stringify({ exporting: telemetry.exporting, lines }))
// Nothing to flush on the way out: the point was the failure, and `shutdown()` would only
// wait on an export that is already known not to work.
process.exit(0)
