import type { Meter } from '@opentelemetry/api'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  type MetricData,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { SERVICE_NAME } from '../config.ts'
import { durationViews } from '../otel.ts'

/**
 * A real meter whose measurements are collected on demand instead of exported.
 *
 * A real `MeterProvider` — the same class `otel.ts` builds, with the same views — rather
 * than a hand-written fake, for the same reason `recording-spans.ts` uses a real tracer
 * provider: the interesting assertions are about what the SDK actually aggregates, and a
 * fake would answer whatever we programmed it to. The views matter in particular, because
 * a bucket boundary that does not resolve real latencies is a bug this file should be able
 * to catch.
 *
 * **It registers no globals**, which is the whole reason `meter` is on `AppDeps`: OTel's
 * global meter provider may only be set once per process, so a test file that set it would
 * silently change every test file that ran after it.
 *
 * Collection is pulled through the READER rather than the exporter — `reader.collect()`
 * runs the observable callbacks and returns the aggregation directly, so a test never has
 * to wait for an export interval to elapse.
 */
export type RecordingMetrics = {
  meter: Meter
  /** Every metric recorded so far, by name, with each series' attributes and value. */
  collect: () => Promise<Recorded[]>
  /** The one metric with this name, or `undefined` if nothing has recorded to it. */
  named: (name: string) => Promise<Recorded | undefined>
  shutdown: () => Promise<void>
}

export type Recorded = {
  name: string
  /** One entry per distinct label combination — which is one time series each. */
  series: Array<{ attributes: Record<string, unknown>; value: number; count?: number }>
}

/** Sums and gauges carry a number; a histogram carries a distribution. Flattened to both. */
const pointValue = (point: MetricData['dataPoints'][number], type: DataPointType) => {
  if (type === DataPointType.HISTOGRAM) {
    const histogram = point.value as { sum?: number; count: number }
    return { value: histogram.sum ?? 0, count: histogram.count }
  }
  return { value: point.value as number }
}

export const recordingMetrics = (): RecordingMetrics => {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({
    exporter,
    // Long enough that it never fires on its own during a test. Everything here goes
    // through `collect()`, so a background export would only add nondeterminism.
    exportIntervalMillis: 2 ** 31 - 1,
  })
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ 'service.name': SERVICE_NAME }),
    views: durationViews(),
    readers: [reader],
  })

  const collect = async (): Promise<Recorded[]> => {
    const { resourceMetrics } = await reader.collect()
    return resourceMetrics.scopeMetrics.flatMap((scope) =>
      scope.metrics.map((metric) => ({
        name: metric.descriptor.name,
        series: metric.dataPoints.map((point) => ({
          attributes: { ...point.attributes },
          ...pointValue(point, metric.dataPointType),
        })),
      })),
    )
  }

  return {
    meter: provider.getMeter('test'),
    collect,
    named: async (name) => (await collect()).find((metric) => metric.name === name),
    shutdown: () => provider.shutdown(),
  }
}
