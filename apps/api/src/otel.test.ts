import { afterAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { isSpanContextValid } from '@opentelemetry/api'
import { type Config, loadConfig } from './config.ts'
import { createTelemetry } from './otel.ts'

/**
 * The SDK is asserted against a real OTLP endpoint, by reading the bytes it sends.
 *
 * That is the point of doing it this way rather than inspecting the provider's
 * configuration: "the resource has a `service.version`" was already true in a version of
 * this file that exported nothing at all, because a misconfigured processor is invisible
 * from the inside. What ADR-0011 actually promises is that the version reaches the
 * backend, so the test reads what the backend would have received.
 */

/**
 * A stand-in collector. Records every OTLP payload posted to it, keeping the two signals
 * apart by the PATH they arrived on — which is also how a real collector tells them apart.
 */
const fakeCollector = () => {
  const paths: string[] = []
  const payloads: OtlpTracePayload[] = []
  const metricPayloads: OtlpMetricPayload[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const path = new URL(request.url).pathname
      paths.push(path)
      const body = await request.json()
      if (path.endsWith('/v1/metrics')) metricPayloads.push(body as OtlpMetricPayload)
      else payloads.push(body as OtlpTracePayload)
      return new Response('{}', { headers: { 'content-type': 'application/json' } })
    },
  })
  const attributesOf = (attributes: Array<{ key: string; value: { stringValue?: string } }>) =>
    Object.fromEntries(attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))
  return {
    /** The base endpoint, as `OTEL_EXPORTER_OTLP_ENDPOINT` is given. */
    endpoint: `http://localhost:${server.port}`,
    payloads,
    paths,
    spanNames: () =>
      payloads.flatMap((payload) =>
        payload.resourceSpans.flatMap((resourceSpan) =>
          resourceSpan.scopeSpans.flatMap((scopeSpan) => scopeSpan.spans.map((span) => span.name)),
        ),
      ),
    metricNames: () =>
      metricPayloads.flatMap((payload) =>
        payload.resourceMetrics.flatMap((resourceMetric) =>
          resourceMetric.scopeMetrics.flatMap((scopeMetric) =>
            scopeMetric.metrics.map((metric) => metric.name),
          ),
        ),
      ),
    resourceAttributes: () =>
      attributesOf(payloads[0]?.resourceSpans[0]?.resource.attributes ?? []),
    metricResourceAttributes: () =>
      attributesOf(metricPayloads[0]?.resourceMetrics[0]?.resource.attributes ?? []),
    stop: () => server.stop(true),
  }
}

type OtlpResource = { attributes: Array<{ key: string; value: { stringValue?: string } }> }

type OtlpTracePayload = {
  resourceSpans: Array<{
    resource: OtlpResource
    scopeSpans: Array<{ spans: Array<{ name: string }> }>
  }>
}

type OtlpMetricPayload = {
  resourceMetrics: Array<{
    resource: OtlpResource
    scopeMetrics: Array<{ metrics: Array<{ name: string }> }>
  }>
}

const configWith = (overrides: Record<string, string> = {}): Config =>
  loadConfig({
    APP_VERSION: '9.9.9',
    GIT_SHA: 'deadbee',
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
    ...overrides,
  })

const started: Array<{ shutdown: () => Promise<void> }> = []
const telemetryFor = (config: Config) => {
  const telemetry = createTelemetry(config)
  started.push(telemetry)
  return telemetry
}

afterAll(async () => {
  for (const telemetry of started) await telemetry.shutdown()
})

describe('what reaches the collector', () => {
  test('every span carries service.name and service.version (ADR-0011)', async () => {
    const collector = fakeCollector()
    const telemetry = telemetryFor(configWith({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint }))

    telemetry.tracer.startSpan('unit-of-work').end()
    await telemetry.forceFlush()

    expect(collector.spanNames()).toEqual(['unit-of-work'])
    expect(collector.resourceAttributes()).toMatchObject({
      'service.name': 'labelloop-api',
      'service.version': '9.9.9',
      'deployment.environment.name': 'test',
      'labelloop.git_sha': 'deadbee',
    })
    collector.stop()
  })

  test('a trailing slash on the endpoint does not become a double slash in the path', async () => {
    const collector = fakeCollector()
    const config = configWith({ OTEL_EXPORTER_OTLP_ENDPOINT: `${collector.endpoint}/` })
    // The normalisation happens in the config schema, so the assertion belongs on the
    // parsed value — by the time the exporter sees it there is nothing left to get wrong.
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(collector.endpoint)

    const telemetry = telemetryFor(config)
    telemetry.tracer.startSpan('unit-of-work').end()
    await telemetry.forceFlush()

    expect(collector.spanNames()).toEqual(['unit-of-work'])
    collector.stop()
  })
})

describe('an unset endpoint', () => {
  test('still produces valid W3C trace ids, because request_id depends on them', () => {
    const telemetry = telemetryFor(configWith())

    expect(telemetry.exporting).toBe(false)
    const span = telemetry.tracer.startSpan('unit-of-work')
    const spanContext = span.spanContext()

    // The property ADR-0010 rests on: `request_id` IS this string, so a deployment with no
    // collector must still mint a real id rather than thirty-two zeroes.
    expect(isSpanContextValid(spanContext)).toBe(true)
    expect(spanContext.traceId).toMatch(/^[0-9a-f]{32}$/)
    // Recorded, not merely identified — an unset endpoint removes the exporter, not the
    // tracing, so attributes set by the middleware and the gateway are still real writes.
    expect(span.isRecording()).toBe(true)
    span.end()

    const second = telemetry.tracer.startSpan('unit-of-work')
    expect(second.spanContext().traceId).not.toBe(spanContext.traceId)
    second.end()
  })

  test('is not an error and needs no configuration to be one', () => {
    // Belt and braces on the zero-secret boot claim (ADR-0009): building the SDK with the
    // minimum viable environment must not throw.
    expect(() => telemetryFor(configWith())).not.toThrow()
  })
})

describe('the batch processor is bounded', () => {
  test('drops spans rather than growing when the collector cannot keep up', async () => {
    // A collector that accepts but does not ANSWER is the failure that matters. Not "the
    // backend is missing" — that fails fast — but "the backend is slow", which is what
    // turns an unbounded buffer into an out-of-memory kill on the API rather than a gap in
    // the traces. The responses are held until this test releases them.
    let delivered = 0
    const slow = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const payload = (await request.json()) as OtlpTracePayload
        for (const resourceSpan of payload.resourceSpans) {
          for (const scopeSpan of resourceSpan.scopeSpans) delivered += scopeSpan.spans.length
        }
        // Slow, not dead. Slow is the case an unbounded queue cannot survive.
        await Bun.sleep(100)
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
    })

    const telemetry = createTelemetry(
      configWith({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${slow.port}` }),
    )

    // Comfortably more than the queue holds. The producer is the request path, so the
    // assertion that matters first is that it is not the one that waits.
    const produced = 6_000
    const startedAt = performance.now()
    for (let index = 0; index < produced; index += 1) telemetry.tracer.startSpan('flood').end()
    const elapsedMs = performance.now() - startedAt

    // Nothing here blocks on the collector: the spans go into a queue, and a full queue
    // refuses them instead of applying backpressure to whoever produced them.
    expect(elapsedMs).toBeLessThan(2_000)

    await telemetry.shutdown()

    // The number is what proves it is bounded: with an unbounded queue every span would
    // eventually be delivered, and the memory holding them would be the API's.
    expect(delivered).toBeGreaterThan(0)
    expect(delivered).toBeLessThan(produced)
    slow.stop(true)
  })
})

describe('the Sentry SDK is a sink, not a tracing strategy (ADR-0007)', () => {
  test('loading it does not take the tracer provider away from us', async () => {
    // A watch item opened at P2, when `@sentry/bun` turned out to depend on `@sentry/node`
    // and therefore on `@opentelemetry/*`: a second SDK that registers its own tracer
    // provider would silently replace the manual one and every span in this codebase would
    // start coming from machinery nobody wrote. `initWithoutDefaultIntegrations` is what
    // prevents it; this is the assertion that the prevention works, so a `bun update` that
    // changes Sentry's defaults fails here rather than in Grafana.
    const probe = Bun.spawn(
      ['bun', 'run', join(import.meta.dir, 'testing/sentry-tracer-probe.ts')],
      {
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
          // A DSN shaped exactly like a real one and pointed at a closed local port, so the
          // SDK initialises for real and cannot reach anything. Self-describing on purpose:
          // a realistic-looking literal here is indistinguishable from a leaked credential.
          SENTRY_DSN: 'https://examplekeynotreal@127.0.0.1:1/0',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [output, errors, exitCode] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ])

    expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: '' })
    const result = JSON.parse(output) as {
      sameProvider: boolean
      recording: boolean
      traceId: string
    }
    expect(result.sameProvider).toBe(true)
    // Behavioural as well as identity-based: a provider that is still ours but no longer
    // recording would be the same bug with a different shape.
    expect(result.recording).toBe(true)
    expect(result.traceId).toMatch(/^[0-9a-f]{32}$/)
  })
})

describe('a collector that rejects what we send it', () => {
  test('says so on the logger instead of failing silently', async () => {
    // Found by unplugging the collector on a running system and watching nothing happen.
    // OpenTelemetry has two unrelated failure channels — `diag` for the SDK's own
    // diagnostics, and the global error handler for export failures — and bridging only
    // the first leaves "the collector is rejecting our spans" indistinguishable from
    // "there is no traffic", which is the most misleading state this stack can be in.
    //
    // A 400 rather than a closed port, and not only because it is faster: OTLP treats a
    // refused connection and a 5xx as retryable and spends its whole export timeout on
    // them, while a 400 is final. Both end at the same error handler; this one ends there
    // in milliseconds.
    const rejecting = Bun.serve({
      port: 0,
      fetch: () => new Response('nope', { status: 400 }),
    })

    const probe = Bun.spawn(
      ['bun', 'run', join(import.meta.dir, 'testing/otel-export-failure-probe.ts')],
      {
        env: {
          PATH: process.env.PATH ?? '',
          NODE_ENV: 'test',
          DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://localhost:${rejecting.port}`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    const [output, exitCode] = await Promise.all([new Response(probe.stdout).text(), probe.exited])
    rejecting.stop(true)

    expect(exitCode).toBe(0)
    const result = JSON.parse(output) as { exporting: boolean; lines: string[] }
    expect(result.exporting).toBe(true)
    // At WARN, not ERROR: dropping spans is degraded-but-serving, and a channel that pages
    // someone for it is a channel that gets muted (CONVENTIONS.md "Logging" levels).
    expect(result.lines.some((line) => line.startsWith('warn'))).toBe(true)
    expect(result.lines.join('\n')).toContain('telemetry export failed')
  })
})

describe('the meter provider (ADR-0041)', () => {
  test('shares the tracer provider s Resource, so a dashboard and a trace name one build', async () => {
    const collector = fakeCollector()
    const telemetry = telemetryFor(configWith({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint }))

    telemetry.tracer.startSpan('unit-of-work').end()
    telemetry.meter.createCounter('unit.of.work').add(1)
    await telemetry.forceFlush()

    // The claim is not "both were configured with the same object" — that is true by
    // construction and would pass with a broken exporter. It is that the two signals
    // ARRIVE carrying the same identity, which is what makes "p95 regressed after v0.4.0"
    // and "show me a slow trace from v0.4.0" the same filter twice (ADR-0011).
    const identity = {
      'service.name': 'labelloop-api',
      'service.version': '9.9.9',
      'deployment.environment.name': 'test',
      'labelloop.git_sha': 'deadbee',
    }
    expect(collector.resourceAttributes()).toMatchObject(identity)
    expect(collector.metricResourceAttributes()).toMatchObject(identity)
    expect(collector.metricNames()).toContain('unit.of.work')
    // Shut down BEFORE the collector goes away. A meter provider always has something to
    // flush — a cumulative counter still holds its total — so a shutdown aimed at a
    // stopped server spends the whole export timeout on a connection OTLP considers
    // retryable, which is the same trap the export-failure test below documents.
    await telemetry.shutdown()
    collector.stop()
  })

  test('metrics and spans go to their own OTLP paths', async () => {
    const collector = fakeCollector()
    const telemetry = telemetryFor(configWith({ OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint }))

    telemetry.tracer.startSpan('unit-of-work').end()
    telemetry.meter.createCounter('unit.of.work').add(1)
    await telemetry.forceFlush()

    // One endpoint in configuration, two signal paths on the wire. Worth asserting because
    // the two exporters are built from the same string and a copy-paste that pointed
    // metrics at `/v1/traces` would be accepted by the collector's receiver and then
    // silently dropped as the wrong message type.
    expect(new Set(collector.paths)).toEqual(new Set(['/v1/traces', '/v1/metrics']))
    await telemetry.shutdown()
    collector.stop()
  })

  test('an unset endpoint leaves the instruments legal and going nowhere (ADR-0009)', async () => {
    const telemetry = telemetryFor(configWith())

    expect(telemetry.exporting).toBe(false)
    // The property that matters for zero-secret boot: no reader, but a real meter, so
    // every `add()` in the codebase is still a legal call and nothing has to branch on
    // whether telemetry happens to be configured.
    expect(() => telemetry.meter.createCounter('unit.of.work').add(1)).not.toThrow()
    await expect(telemetry.forceFlush()).resolves.toBeUndefined()
  })
})
