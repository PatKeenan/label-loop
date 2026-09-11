import type { Counter, Histogram, Meter } from '@opentelemetry/api'
import {
  METRIC_JUDGE_ATTEMPTS,
  METRIC_JUDGE_CALLS,
  METRIC_JUDGE_COST_USD,
  METRIC_JUDGE_DURATION,
  METRIC_JUDGE_INPUT_TOKENS,
  METRIC_JUDGE_OUTPUT_TOKENS,
  METRIC_JUDGE_REASONING_TOKENS,
} from './llm/attributes.ts'

/**
 * Every instrument this service records to, defined once.
 *
 * **Metric names follow the span attribute rule** (`llm/attributes.ts` states it): an
 * industry convention is spelled out under its own name, and anything of ours is
 * namespaced `labelloop.*` so a convention arriving later cannot collide with it. They are
 * written in OTel's dotted form rather than Prometheus's underscored one because that is
 * the form the SDK takes; the collector's `prometheus` exporter translates
 * `labelloop.judge.cost_usd` to `labelloop_judge_cost_usd_total` on the way out, so the two
 * conventions each stay correct on their own side of the pipeline instead of one leaking
 * into the other.
 *
 * **Cardinality is decided here, at definition, and nowhere else** (ADR-0041/ADR-0042).
 * No key id, org id, panel id, trace id or artifact-derived value is a label on anything
 * below, which is why per-key usage is a SQL `GROUP BY` against Postgres instead: a query
 * costs a query, and a Prometheus label costs a time series forever.
 * `metrics.cardinality.test.ts` asserts it against what the instruments actually record,
 * because the rule's violation is silent and its reversal is breaking — a label cannot be
 * dropped without breaking every dashboard built on it.
 */

/** OTel's own name for server-side HTTP duration. Seconds, per the convention. */
export const METRIC_HTTP_SERVER_DURATION = 'http.server.request.duration'
/**
 * Ours: the convention derives request COUNT from the histogram's `_count`, which is
 * correct and unreadable. An explicit counter is one extra series per route and status
 * class and makes "error rate" a division a dashboard panel can state in one line.
 */
export const METRIC_HTTP_SERVER_REQUESTS = 'labelloop.http.server.requests'
/** Allowed against refused, split by `labelloop.decision`. */
export const METRIC_RATE_LIMIT_DECISIONS = 'labelloop.rate_limit.decisions'
/**
 * The other half of ADR-0040's visibility. A fail-open limiter is invisible when it breaks
 * — it serves everything and logs a warning nobody is reading — so the count of times it
 * failed open is the number that says traffic was unlimited for a while.
 */
export const METRIC_RATE_LIMIT_FAIL_OPEN = 'labelloop.rate_limit.fail_open'

/** `2xx` / `4xx` / `5xx`. The status CODE would be five times the series for no question. */
export const ATTR_STATUS_CLASS = 'labelloop.status_class'
/** `allowed` / `refused`. */
export const ATTR_DECISION = 'labelloop.decision'

/**
 * Bucket boundaries, in SECONDS, taken from measurements rather than from a default.
 * `docs/BREAKING_POINT.md` §2: refused requests land at 9.5–31.9 ms and served ones at
 * 5.29–5.35 s under load, so a histogram has to resolve both ends or p95 is a bucket edge.
 *
 * **Resolution between 1s and 6s is half a second, and that is a CORRECTION** (M3 phase 5).
 * The first version jumped `1, 2.5, 5, 7.5`, which bracketed the served population in a
 * single 2.5-second-wide bucket — and `histogram_quantile` assumes observations spread
 * uniformly across a bucket, so it interpolated across ground the data never occupied.
 * Measured against k6, which times requests directly rather than through buckets:
 *
 *   k6 served_duration p95   5.33s   (450 requests, judge at 4000ms ± 1500)
 *   this histogram, before   6.76s   +1.43s, 27% high
 *
 * The arithmetic was exact rather than approximate: 369.2 observations at or below 5s and
 * 74.9 in the (5, 7.5] bucket put p95 52.7 of the way into a bucket of 74.9, so
 * `5 + (52.7/74.9) × 2.5 = 6.76`. Every one of those 74.9 was really between 5.0 and 5.52.
 *
 * A dashboard that overstates p95 by a quarter is worse than no dashboard, because it gets
 * quoted. The lesson generalises: bucket boundaries have to straddle where the system
 * ACTUALLY sits, and the only way to know that is to measure and compare.
 */
const HTTP_DURATION_BUCKETS_S = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7.5, 10, 30,
]

/**
 * Wider, because a judge call is a network call to someone else's model: the fake's
 * measured shape is 4 s ± 1.5, and the retry policy allows three attempts at a 10 s
 * timeout with backoff between them, so the tail this has to resolve runs to ~35 s.
 *
 * These were already finer than the HTTP set in the region that matters — one-second
 * buckets rather than 2.5 — and the same comparison showed it: 5.70s against k6's 5.33s,
 * a 7% overstatement instead of 27%. Halving the buckets across 2–6 s brings the
 * interpolation error down with it. Cost per verdict and latency per judge are the two
 * numbers this product's argument is made of, so they are worth the extra series.
 */
const JUDGE_DURATION_BUCKETS_S = [
  0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6, 7, 8, 10, 15, 30, 60,
]

export const DURATION_BUCKETS = {
  [METRIC_HTTP_SERVER_DURATION]: HTTP_DURATION_BUCKETS_S,
  [METRIC_JUDGE_DURATION]: JUDGE_DURATION_BUCKETS_S,
} as const

export type Instruments = {
  httpDuration: Histogram
  httpRequests: Counter
  judgeCalls: Counter
  judgeDuration: Histogram
  judgeInputTokens: Counter
  judgeOutputTokens: Counter
  judgeReasoningTokens: Counter
  judgeCostUsd: Counter
  judgeAttempts: Counter
  rateLimitDecisions: Counter
  rateLimitFailOpen: Counter
}

const build = (meter: Meter): Instruments => ({
  httpDuration: meter.createHistogram(METRIC_HTTP_SERVER_DURATION, {
    description: 'Duration of inbound HTTP requests.',
    unit: 's',
  }),
  httpRequests: meter.createCounter(METRIC_HTTP_SERVER_REQUESTS, {
    description: 'Inbound HTTP requests, by route and status class.',
  }),
  judgeCalls: meter.createCounter(METRIC_JUDGE_CALLS, {
    description: 'Judge calls through the gateway, by model and outcome.',
  }),
  judgeDuration: meter.createHistogram(METRIC_JUDGE_DURATION, {
    description: 'Wall-clock for one judge call, retries and backoff included.',
    unit: 's',
  }),
  judgeInputTokens: meter.createCounter(METRIC_JUDGE_INPUT_TOKENS, {
    description: 'Prompt tokens billed by the provider.',
    unit: '{token}',
  }),
  judgeOutputTokens: meter.createCounter(METRIC_JUDGE_OUTPUT_TOKENS, {
    description: 'Completion tokens billed by the provider.',
    unit: '{token}',
  }),
  judgeReasoningTokens: meter.createCounter(METRIC_JUDGE_REASONING_TOKENS, {
    description: 'Billed deliberation the provider reported, when it reported any.',
    unit: '{token}',
  }),
  judgeCostUsd: meter.createCounter(METRIC_JUDGE_COST_USD, {
    description: 'Spend on judge calls, in USD. Split by labelloop.cost_priced, never summed.',
    // **No `unit`, deliberately, and the name carries it instead.** The OTLP-to-Prometheus
    // translation APPENDS a unit to the metric name, so `unit: 'USD'` publishes
    // `labelloop_judge_cost_usd_USD_total` — the unit twice, once shouting. The token
    // counters below keep theirs because `{token}` is a UCUM annotation, which the same
    // translation correctly leaves out of the name. Found by reading the exporter's output
    // rather than by reasoning about it.
  }),
  judgeAttempts: meter.createCounter(METRIC_JUDGE_ATTEMPTS, {
    description: 'Provider calls actually made. A success after two retries is not one call.',
  }),
  rateLimitDecisions: meter.createCounter(METRIC_RATE_LIMIT_DECISIONS, {
    description: 'Rate-limit decisions, by outcome.',
  }),
  rateLimitFailOpen: meter.createCounter(METRIC_RATE_LIMIT_FAIL_OPEN, {
    description: 'Times the limiter served a request because its store was unreachable.',
  }),
})

const cache = new WeakMap<Meter, Instruments>()

/**
 * The instruments for a meter, built once per meter.
 *
 * Memoised rather than rebuilt because the call sites are middleware and a gateway, and
 * `createCounter` on every request would allocate an instrument object per request to
 * reach the same aggregation the SDK already keyed by name. A `WeakMap` rather than a
 * module-level singleton because the METER is the injected seam (`app-env.ts`): a test
 * passing its own meter must get its own instruments, and must not inherit the ones some
 * earlier test file recorded to.
 */
export const instrumentsFor = (meter: Meter): Instruments => {
  const existing = cache.get(meter)
  if (existing !== undefined) return existing
  const instruments = build(meter)
  cache.set(meter, instruments)
  return instruments
}

/** `2xx`, `4xx`, `5xx` — the low-cardinality half of a status code. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`
