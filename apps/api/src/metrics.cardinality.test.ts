import { beforeEach, describe, expect, test } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { Hono } from 'hono'
import { createFixedClock } from './adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from './adapters/noop-error-reporter.ts'
import { createApp } from './app.ts'
import type { AppEnv } from './app-env.ts'
import { type Config, loadConfig } from './config.ts'
import { createFakeProvider, createModelGateway, FAKE_MODEL, FAKE_SENTINELS } from './llm/index.ts'
import { byApiKey, rateLimit } from './middleware/rate-limit.ts'
import { createMemoryRateLimitStore } from './rate-limit/memory-store.ts'
import { fakeAuth } from './testing/fake-auth.ts'
import { fakeDatabase } from './testing/fake-database.ts'
import { fakeQueue } from './testing/fake-queue.ts'
import { type Recorded, recordingMetrics } from './testing/recording-metrics.ts'

/**
 * **The cardinality rule, enforced rather than remembered** (ADR-0042, in the spirit of
 * ADR-0016).
 *
 * No key id, org id, panel id, trace id or artifact-derived value may ever be a metric
 * label. Per-key usage is a SQL `GROUP BY` against Postgres instead, because a query costs
 * a query and a Prometheus label costs a time series forever.
 *
 * It is a test rather than a review note because this is the rule whose violation is
 * SILENT and whose reversal is BREAKING. Adding an id label is one cheap line that passes
 * every other check in the repo; removing it later breaks every dashboard and alert built
 * on the series it created. So the failure has to happen at the moment the line is written.
 *
 * The assertions run in two registers on purpose:
 *
 * 1. **By name** — the label keys nobody may use. Readable, and it states the rule.
 * 2. **By SHAPE** — no attribute VALUE anywhere may look like one of our prefixed ULIDs or
 *    like a W3C trace id. This is the half that cannot be worked around: renaming the label
 *    to `tenant` or `subject` defeats the first check and not this one.
 *
 * And it asserts against what the instruments ACTUALLY RECORDED after the real funnels
 * ran, not against a list of intentions.
 */

const config: Config = loadConfig({
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgres://app:localdev@localhost:5433/labelloop',
})

const noopTracer = trace.getTracer('test')

/** Label keys that are banned by name. The list CONVENTIONS' "Metrics" section states. */
const FORBIDDEN_LABELS = [
  'key_id',
  'labelloop.key_id',
  'api_key',
  'subject',
  'org_id',
  'labelloop.org_id',
  'panel_id',
  'labelloop.panel_id',
  'panel_version_id',
  'trace_id',
  'labelloop.trace_id',
  'request_id',
  'labelloop.request_id',
  'user_id',
  'annotator_id',
  'artifact',
  'url.full',
  'url.path',
  'user_agent.original',
  'client.address',
]

/**
 * Anything shaped like an identifier, whatever it has been called. The prefixes are
 * CONVENTIONS' own list; the trailing 26 characters are Crockford base32, which is what a
 * ULID's body is.
 */
const LOOKS_LIKE_AN_ID =
  /^(?:org|pnl|pnv|jud|jdv|tax|tr|ann|key|ds|ft|aud)_[0-9A-HJKMNP-TV-Z]{26}$/i
/** A W3C trace id — which is to say a `request_id` (ADR-0010), under any label name. */
const LOOKS_LIKE_A_TRACE_ID = /^[0-9a-f]{32}$/
/** The seeded and test key format. Not a ULID, and just as unwelcome. */
const LOOKS_LIKE_AN_API_KEY = /^llk_(?:live|test)_/

/** Ids as they appear in this test's traffic, so a leak has something recognisable to be. */
const PANEL_ID = 'pnl_01JZZZZZZZZZZZZZZZZZZZZZZZ'
const KEY_ID = 'key_01JZZZZZZZZZZZZZZZZZZZZZZZ'
const ORG_ID = 'org_01JZZZZZZZZZZZZZZZZZZZZZZZ'

const CALL = {
  model: FAKE_MODEL,
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17.',
}

let recorded: ReturnType<typeof recordingMetrics>

beforeEach(() => {
  recorded = recordingMetrics()
})

/**
 * Every funnel, driven once, with identifying values threaded through all of them: real
 * panel ids in the URL, a real key id on the authenticated context, an artifact with
 * content in it. If any of those reaches a series, the assertions below find it.
 */
const driveEverything = async (): Promise<Recorded[]> => {
  const gateway = createModelGateway({
    provider: createFakeProvider(),
    clock: createFixedClock(),
    tracer: noopTracer,
    meter: recorded.meter,
  })

  const app = createApp({
    config,
    clock: createFixedClock(),
    errorReporter: createRecordingErrorReporter(),
    db: fakeDatabase(),
    modelGateway: gateway,
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: recorded.meter,
    auth: fakeAuth(),
    rateLimitStore: createMemoryRateLimitStore(),
  })

  const probe = new Hono<AppEnv>()
  probe.use('/probe', async (c, next) => {
    c.set('apiKey', { id: KEY_ID, orgId: ORG_ID, panelId: PANEL_ID })
    await next()
  })
  probe.use('/probe', rateLimit({ subject: byApiKey, policy: { capacity: 1, refillPerSecond: 1 } }))
  probe.get('/probe', (c) => c.json({ ok: true }, 200))
  app.route('/probe-host', probe)

  // The HTTP funnel: a matched route carrying an id, an unmatched one, and an error.
  await app.request('/healthz')
  await app.request(`/v1/panels/${PANEL_ID}/evaluate`, { method: 'POST' })
  await app.request(`/v1/panels/${PANEL_ID}/traces/tr_01JZZZZZZZZZZZZZZZZZZZZZZZ`)
  // The rate-limit funnel: one served, one refused (capacity is 1).
  await app.request('/probe-host/probe')
  await app.request('/probe-host/probe')
  // The judge funnel: an evaluated call, a failed one, and an unreachable provider —
  // three of the five exits, with the judge and version the caller knows about attached.
  const context = { slug: 'is-missing-repro', judgeVersionId: 'jdv_01JZZZZZZZZZZZZZZZZZZZZZZZ' }
  await gateway.judge({ ...CALL }, context)
  await gateway.judge({ ...CALL, artifact: `${FAKE_SENTINELS.invalidOutput} x` }, context)
  await gateway.judge({ ...CALL, artifact: `${FAKE_SENTINELS.unavailable} x` }, context)

  return await recorded.collect()
}

/** Every `[metric, label, value]` triple that was actually recorded. */
const everyLabel = (metrics: Recorded[]) =>
  metrics.flatMap((metric) =>
    metric.series.flatMap((series) =>
      Object.entries(series.attributes).map(([key, value]) => ({
        metric: metric.name,
        key,
        value: String(value),
      })),
    ),
  )

describe('no metric label identifies anybody (ADR-0042)', () => {
  test('the drive actually produced metrics — a rule over zero series proves nothing', async () => {
    const metrics = await driveEverything()
    expect(metrics.length).toBeGreaterThan(5)
    expect(everyLabel(metrics).length).toBeGreaterThan(10)
  })

  test('no banned label name appears on any series', async () => {
    const offences = everyLabel(await driveEverything())
      .filter(({ key }) => FORBIDDEN_LABELS.includes(key))
      .map(({ metric, key }) => `${metric} carries the banned label \`${key}\``)
    expect(offences).toEqual([])
  })

  test('no label VALUE is an id, whatever the label was called', async () => {
    // The check that survives someone renaming the label. Ids were threaded through every
    // funnel above — the panel in the URL, the key on the context, the judge version on
    // the call — so if any of them reaches a series this is what says which.
    const offences = everyLabel(await driveEverything())
      .filter(
        ({ value }) =>
          LOOKS_LIKE_AN_ID.test(value) ||
          LOOKS_LIKE_A_TRACE_ID.test(value) ||
          LOOKS_LIKE_AN_API_KEY.test(value),
      )
      .map(({ metric, key, value }) => `${metric}.${key} = ${value}`)
    expect(offences).toEqual([])
  })

  test('and the id-shape check would catch one, so it is not vacuously green', async () => {
    // A rule that cannot fail is not a rule. This proves the regexes recognise the exact
    // strings the drive above puts into circulation.
    expect(LOOKS_LIKE_AN_ID.test(PANEL_ID)).toBe(true)
    expect(LOOKS_LIKE_AN_ID.test(KEY_ID)).toBe(true)
    expect(LOOKS_LIKE_AN_ID.test('jdv_01JZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(true)
    expect(LOOKS_LIKE_A_TRACE_ID.test('4bf92f3577b34da6a3ce929d0e0e4736')).toBe(true)
    expect(LOOKS_LIKE_AN_API_KEY.test('llk_test_0000')).toBe(true)
    // And does not fire on the labels that ARE allowed, or the rule would ban everything.
    expect(LOOKS_LIKE_AN_ID.test('/v1/panels/:panel_id/evaluate')).toBe(false)
    expect(LOOKS_LIKE_AN_ID.test(FAKE_MODEL)).toBe(false)
    expect(LOOKS_LIKE_AN_ID.test('is-missing-repro')).toBe(false)
  })

  test('the number of series stays bounded by design, not by traffic', async () => {
    const metrics = await driveEverything()
    // Ten calls across every funnel produced this many series. The number is not the
    // point; its INDEPENDENCE from traffic is. A label carrying an id would make this
    // grow with the number of distinct panels and keys in the drive above, and the ceiling
    // would be however many customers exist.
    for (const metric of metrics) {
      expect(metric.series.length).toBeLessThan(10)
    }
  })
})
