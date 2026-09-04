import { check } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'
import { assertJudgesAreSlow, evaluate, json } from './load-lib.js'

/**
 * The RAMP (SENIORITY_CHECKLIST 5, M2). Load climbs in stages until something gives, so
 * `docs/BREAKING_POINT.md` can say where the knee is and what the system does past it.
 *
 * **Operator-run, never in CI.** The smoke test beside this file is the CI gate: it takes a
 * second and asserts the stack works. A ramp takes minutes, and minutes of load on a shared
 * runner buys nothing but a flaky pipeline and a latency number measured against whatever
 * else that runner was doing.
 *
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml up -d --wait api
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml --profile k6 run --rm k6 run /scripts/ramp.js
 *
 * **The variables are repeated on BOTH commands, and that is not redundancy.** `compose run`
 * recreates any dependency whose environment differs from the running container, so omitting
 * them the second time silently restarts the API at zero latency. `setup()` refuses to run
 * when that has happened; `load-lib.js` explains it in full.
 *
 * **Point it at a stack whose fake has latency.** Against the default zero-latency fake
 * this measures the throughput of a hash function, which is not a fact about this system.
 *
 * What it is really measuring, and it is worth being honest about it up front: this is one
 * API instance, one Postgres, one Redis, on one machine, against a fake judge. It bounds
 * what THIS topology does. It says nothing about a real provider's latency or cost, about
 * more than one instance, or about anything sustained for longer than these stages run —
 * and BREAKING_POINT.md has to say so rather than imply evidence it does not have.
 *
 * **Read `served_duration`, never `http_req_duration`.** This run produces two populations
 * of request that have nothing to do with each other: a served evaluation waits on a judge
 * for seconds, and a refused one is rejected in single-digit milliseconds without touching
 * anything. With one key at 60/minute, the overwhelming majority of a ramp is refusals — so
 * the overall p95 is dominated by the cheap population and reads as a wonderful latency
 * number that describes nothing anyone cares about. Measured on 2026-09-04: 3944 req/s at
 * an overall p95 of 11.89ms, of which essentially every request was a 429.
 *
 * So the thresholds below are on the SERVED population, and the useful question this run
 * answers is not "how many requests per second" — one key cannot generate more than one
 * served request per second, so the limiter is the binding constraint long before the
 * system is. It is: **does a flood of refusals degrade the calls that ARE served?** That is
 * a real capacity question, it can fail, and it is what `served_duration` is watching.
 */

/** Stage length and peak, overridable so an operator can push past the knee once found. */
const PEAK_VUS = Number(__ENV.PEAK_VUS || 60)
const STAGE = __ENV.STAGE_DURATION || '1m'

/**
 * The two populations, kept apart. `served_duration` is the number that means something;
 * `limited_rate` and `limited_total` say how much of the run the limiter refused, which is
 * the other headline `docs/BREAKING_POINT.md` wants.
 */
const servedDuration = new Trend('served_duration', true)
const refusedDuration = new Trend('refused_duration', true)
const limitedRate = new Rate('limited_rate')
const limitedTotal = new Counter('limited_total')

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        // Four steps rather than a smooth climb, so a plateau is legible in Grafana as a
        // step rather than as a slope — the knee is easier to name when the load is flat
        // either side of it.
        { duration: STAGE, target: Math.round(PEAK_VUS * 0.25) },
        { duration: STAGE, target: Math.round(PEAK_VUS * 0.5) },
        { duration: STAGE, target: Math.round(PEAK_VUS * 0.75) },
        { duration: STAGE, target: PEAK_VUS },
        // Back to nothing, which is the half of the run people forget to look at: recovery
        // is a property too, and a system that stays degraded after the load stops has told
        // you something a peak number never will.
        { duration: '30s', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // **These are meant to be able to FAIL.** A threshold nothing can trip is a comment.
    //
    // On the SERVED population only — see the header. Against a fake judge configured at
    // 4000ms ± 1500 the dependency's own ceiling is 5500ms, so anything above that is
    // queueing and contention rather than the judge, which is precisely what this run is
    // looking for. Two seconds of headroom over that ceiling, and no more.
    //
    // This is the threshold that answers the actual question: if thousands of refusals a
    // second were stealing time from the calls that get served, it trips.
    served_duration: ['p(95)<7500'],
    // Not a rate to be minimised: the limiter is EXPECTED to refuse, so the useful
    // assertion is that nothing fails for any OTHER reason. `EXPECTED` above has already
    // told k6 a 429 is healthy, so anything counted here is a 5xx or a dropped connection.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
    // A refusal must stay cheap. If refusing got expensive, excess traffic would cost the
    // system real work and the limiter would stop being a defence.
    refused_duration: ['p(95)<1000'],
    // Recorded, not asserted: how much of the run was refused is a finding to report rather
    // than a bar to clear, and hard-coding an expected proportion would make the threshold
    // fail whenever someone legitimately changes the stages.
    limited_rate: ['rate>=0'],
  },
}

/**
 * Runs once, before any load. It refuses to start a run that would measure nothing — see
 * `assertJudgesAreSlow` in `load-lib.js` for the silent failure this exists to prevent.
 */
export function setup() {
  const probe = assertJudgesAreSlow()
  console.log(
    probe.checked
      ? `judge latency verified at ~${probe.probeMs}ms — this run measures something`
      : `judge latency NOT verified (${probe.reason || 'skipped by ALLOW_FAST_JUDGE'})`,
  )
  return probe
}

export default function () {
  // A per-VU artifact, so the fake's deterministic latency spreads across the population
  // rather than every virtual user drawing the same delay from the same hash — which would
  // turn a distribution into a single value and make the p95 meaningless.
  const artifact = `ramp artifact for vu ${__VU} iteration ${__ITER}`

  const res = evaluate(artifact)

  const body = json(res)

  // Recorded before any check, so the split is honest even on a run that fails a threshold.
  limitedRate.add(res.status === 429)
  if (res.status === 200) servedDuration.add(res.timings.duration)
  if (res.status === 429) {
    refusedDuration.add(res.timings.duration)
    limitedTotal.add(1)
  }

  check(res, {
    'answered 200 or 429, and nothing else': (r) => r.status === 200 || r.status === 429,
    // Every response carries one, success or failure (ADR-0010) — including under load,
    // which is when someone actually needs it to quote at support.
    'carries a request_id': () => typeof body?.request_id === 'string',
  })

  if (res.status === 200) {
    check(res, {
      'a served call still returns a decision': () => typeof body?.data?.passed === 'boolean',
      'and its trace was captured (ADR-0001)': () =>
        typeof body?.data?.trace_id === 'string' && body.data.trace_id.startsWith('tr_'),
    })
  }

  if (res.status === 429) {
    check(
      res,
      {
        // The limiter refusing is a SUCCESS of the system, and it still has to be
        // well-formed: the code the console branches on, and the header it turns into a
        // timer. A 429 with neither is a bug that a load test is the only place to catch.
        'a refusal names RATE_LIMITED': () => body?.error?.code === 'RATE_LIMITED',
        'and carries Retry-After': (r) => Number(r.headers['Retry-After']) > 0,
      },
      { kind: 'limited' },
    )
  }
}
