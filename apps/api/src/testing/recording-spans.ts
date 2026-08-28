import type { Tracer } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { SERVICE_NAME } from '../config.ts'

/**
 * A real tracer whose spans are kept in memory instead of being exported.
 *
 * It is a real `BasicTracerProvider` — the same class `otel.ts` builds — rather than a
 * hand-written fake, because the interesting assertions are about what the SDK actually
 * records: sampling, parent/child linkage, attribute coercion, span status. A fake tracer
 * would answer whatever we programmed it to.
 *
 * **It registers no globals.** OTel's global tracer provider may only be set once per
 * process, so a test file that set it would silently change every test file that ran after
 * it. Every seam that needs a tracer takes one as a parameter for exactly this reason.
 */
export type RecordingSpans = {
  tracer: Tracer
  /** Everything ENDED so far, oldest first. Unended spans are deliberately absent. */
  spans: () => ReadableSpan[]
  /** Ended spans with this name. The common lookup, spelled once. */
  named: (name: string) => ReadableSpan[]
  reset: () => void
  shutdown: () => Promise<void>
}

export const recordingSpans = (attributes: Record<string, string> = {}): RecordingSpans => {
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME, ...attributes }),
    // Simple, not batched: a test asserting on spans should not also be asserting on a
    // scheduler. `otel.test.ts` owns the batching behaviour, against a real exporter.
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })

  return {
    tracer: provider.getTracer('test'),
    spans: () => exporter.getFinishedSpans(),
    named: (name) => exporter.getFinishedSpans().filter((span) => span.name === name),
    reset: () => exporter.reset(),
    shutdown: () => provider.shutdown(),
  }
}
