import { check } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { assertJudgesAreSlow, evaluate, json } from './load-lib.js'

/**
 * The SOAK (SENIORITY_CHECKLIST 5, M3). Low, steady, and long — the run that answers a
 * question none of the others can: does this system degrade when nothing is wrong?
 *
 * **M2 deferred this to M3 deliberately, and the reason is the whole ordering of that
 * plan.** A soak with no dashboard is an hours-long run nobody can watch. Everything that
 * makes a leak legible — the metrics pipeline, the service and judge dashboards, memory
 * over time — is phases 1 to 4 of this milestone, so the soak comes last and is watched.
 *
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml up -d --wait api
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml --profile k6 run --rm k6 run /scripts/soak.js
 *
 * The variables are repeated on BOTH commands for the reason `ramp.js` and `load-lib.js`
 * spell out: `compose run` recreates a dependency whose environment differs from the
 * running container, so omitting them the second time restarts the API at zero latency and
 * the run measures a hash function. `setup()` refuses when that has happened.
 *
 * **DELIBERATELY BELOW THE RATE LIMIT, and this is the design decision.** One key refills
 * at one token per second (`DEFAULT_RATE_LIMIT`: capacity 60, refill 1/s), so a soak at or
 * above 1 req/s becomes a soak of 429s — thousands of refusals that never reach a judge,
 * never touch the queue, and never allocate anything worth watching for hours. That is the
 * trap `ramp.js` documents from the other direction, and it would make this run measure
 * nothing at all. 45/minute is 25% under the refill rate: enough headroom that a slow
 * moment does not start refusing, and every single iteration exercises the real path —
 * gateway, provider call, cost accounting, trace write, queue job.
 *
 * **What k6 can and cannot tell you here.** k6 asserts that nothing BROKE: latency stayed
 * inside its bound, nothing 5xx'd, every response was well-formed. It cannot see a leak,
 * because a leak is a SLOPE and k6 reports a distribution. The evidence for the actual
 * question — is memory flat across two hours — lives in Grafana, which is why this is the
 * phase that had to wait for the dashboards. Watch the API's and Tempo's memory, the p95 on
 * the service dashboard, and whether the breaker gauge ever leaves zero.
 *
 * **Either outcome is publishable** (CLAUDE.md: honest results over impressive ones).
 * Memory flat is a result. A leak found is a better one than not having looked.
 */

/** Two hours by default: long enough for a slow slope to separate from noise. */
const DURATION = __ENV.SOAK_DURATION || '2h'
/**
 * Iterations per minute. 45 against a refill of 60/minute — see the header for why staying
 * under it is the point rather than a detail.
 */
const RATE_PER_MIN = Number(__ENV.SOAK_RATE_PER_MIN || 45)

/**
 * The same two populations `ramp.js` keeps apart, for the same reason — except that here a
 * refusal is a WARNING rather than an expected outcome, because it means the run stopped
 * measuring the thing it exists to measure.
 */
const servedDuration = new Trend('served_duration', true)
const refusedDuration = new Trend('refused_duration', true)
const limitedRate = new Rate('limited_rate')
const limitedTotal = new Counter('limited_total')

export const options = {
  scenarios: {
    soak: {
      // Arrival-rate, not VUs: a soak has to hold a STEADY offered load. With
      // `ramping-vus`, slower responses would mean fewer requests, so the load would
      // quietly fall away exactly when the system started struggling — which is the moment
      // the evidence matters most.
      executor: 'constant-arrival-rate',
      rate: RATE_PER_MIN,
      timeUnit: '1m',
      duration: DURATION,
      // At 0.75 req/s against a judge answering in 4000ms ± 1500, roughly four calls are in
      // flight at any moment. Ten pre-allocated is comfortable headroom; twenty is the
      // ceiling, and k6 warns loudly if it ever needs them — which would itself be a
      // finding, since it would mean latency had grown.
      preAllocatedVUs: 10,
      maxVUs: 20,
    },
  },
  thresholds: {
    // The same bound `ramp.js` uses and for the same arithmetic: the fake's own ceiling is
    // 5500ms, so anything past 7500 is queueing and contention rather than the dependency.
    // Over two hours this is the threshold that catches slow degradation — a leak usually
    // shows up as latency before it shows up as a crash.
    served_duration: ['p(95)<7500'],
    // **The soak-specific one.** If the limiter is refusing, this run is not exercising the
    // evaluation path and its results describe nothing. Two percent tolerates a stray
    // refusal at a boundary; anything more means the rate is set wrong and the run should
    // be thrown away rather than reported.
    limited_rate: ['rate<0.02'],
    // `EXPECTED` already tells k6 a 429 is healthy, so anything here is a 5xx or a dropped
    // connection — over two hours, at a rate no rate limiter is refusing.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
  },
}

export function setup() {
  const probe = assertJudgesAreSlow()
  console.log(
    probe.checked
      ? `judge latency verified at ~${probe.probeMs}ms — this run measures something`
      : `judge latency NOT verified (${probe.reason || 'skipped by ALLOW_FAST_JUDGE'})`,
  )
  console.log(
    `soak: ${RATE_PER_MIN}/min for ${DURATION}, under the limiter's 60/min refill. ` +
      'Watch memory and p95 in Grafana — k6 cannot see a slope.',
  )
  return { ...probe, startedAt: Date.now() }
}

export default function (data) {
  // Per-VU AND per-iteration, so the fake's deterministic latency is drawn fresh every
  // call. A constant artifact would make every request take the same hashed delay and turn
  // the whole distribution into one value.
  const artifact = `soak artifact for vu ${__VU} iteration ${__ITER}`

  const res = evaluate(artifact)
  const body = json(res)

  limitedRate.add(res.status === 429)
  if (res.status === 200) servedDuration.add(res.timings.duration)
  if (res.status === 429) {
    refusedDuration.add(res.timings.duration)
    limitedTotal.add(1)
    // Said out loud, because in THIS run a refusal is a problem with the run rather than a
    // property of the system, and the operator is watching a dashboard for two hours.
    console.warn(
      `refused at iteration ${__ITER} — the soak is above the limiter's refill rate and is ` +
        'no longer exercising the evaluation path',
    )
  }

  check(res, {
    'answered 200 or 429, and nothing else': (r) => r.status === 200 || r.status === 429,
    'carries a request_id': () => typeof body?.request_id === 'string',
  })

  if (res.status === 200) {
    check(res, {
      'a served call still returns a decision': () => typeof body?.data?.passed === 'boolean',
      // Still true at hour two, which is the claim a soak is uniquely able to make: ADR-0001
      // says every judge call is captured, and "every" includes the ten-thousandth.
      'and its trace was captured (ADR-0001)': () =>
        typeof body?.data?.trace_id === 'string' && body.data.trace_id.startsWith('tr_'),
    })
  }

  // A heartbeat roughly every fifteen minutes at the default rate, so the operator watching
  // Grafana can line a timestamp up with a shape on a graph.
  if (__ITER > 0 && __ITER % 675 === 0) {
    const minutes = Math.round((Date.now() - data.startedAt) / 60000)
    console.log(`soak: ${__ITER} iterations, ~${minutes} minutes elapsed`)
  }
}
