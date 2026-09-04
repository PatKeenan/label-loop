import { check } from 'k6'
import { Rate, Trend } from 'k6/metrics'
import { assertJudgesAreSlow, evaluate, json } from './load-lib.js'

/**
 * The SPIKE (SENIORITY_CHECKLIST 5, M2). A step change rather than a slope: load goes from
 * almost nothing to well past the limit in ten seconds, sits there, and drops again.
 *
 * **It asks a different question from `ramp.js`, which is why it is a second file.** The
 * ramp finds where the knee is. The spike asks what the system does when it is given no
 * warning — whether the limiter refuses cleanly at the cliff instead of the API queueing
 * work it will never serve in time, and whether anything is still broken thirty seconds
 * after the load is gone. A gradual climb lets pools and buckets adapt on the way up and
 * hides exactly that.
 *
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml up -d --wait api
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml --profile k6 run --rm k6 run /scripts/spike.js
 *
 * **The variables are repeated on BOTH commands, and that is not redundancy.** `compose run`
 * recreates any dependency whose environment differs from the running container, so omitting
 * them the second time silently restarts the API at zero latency. `setup()` refuses to run
 * when that has happened; `load-lib.js` explains it in full.
 *
 * Point it at a stack whose fake has latency, for the reason `ramp.js` gives at length.
 * Operator-run, never in CI, for the same reason.
 *
 * **Read `served_duration`, never `http_req_duration`** — the same two-populations trap
 * `ramp.js` documents at length, and worse here: at the cliff almost everything is refused,
 * so the overall p95 would read as excellent precisely when the system is under most stress.
 */
const servedDuration = new Trend('served_duration', true)
const refusedDuration = new Trend('refused_duration', true)
const limitedRate = new Rate('limited_rate')

/**
 * Deliberately far above the 60/minute limit. The point is not to find the limit — the ramp
 * does that — but to arrive well past it instantly, so the refusal path is what is under
 * observation rather than the boundary.
 */
const SPIKE_VUS = Number(__ENV.SPIKE_VUS || 150)

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        // A baseline first, so the spike has something to be a change FROM. Without it the
        // graph starts at the cliff and there is nothing to compare the recovery against.
        { duration: '30s', target: 5 },
        // The cliff.
        { duration: '10s', target: SPIKE_VUS },
        { duration: '1m', target: SPIKE_VUS },
        // Off it, just as abruptly.
        { duration: '10s', target: 5 },
        // **The most informative stage in the file.** Back at the baseline, latency should
        // return to what it was in the first 30 seconds. If it does not, something is still
        // draining — a queue, a pool, a breaker that has not closed — and that is a finding
        // no peak number would ever have shown.
        { duration: '1m', target: 5 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: {
    // Looser than the ramp's on purpose, and on the served population for the reason in the
    // header: a cliff produces a burst of queueing before the limiter has drained it, and
    // asserting the ramp's p95 here would fail on the very behaviour this script exists to
    // observe. What must still hold is that the system REFUSES rather than falls over.
    served_duration: ['p(95)<12000'],
    // A refusal must stay cheap even at the cliff — that is what makes the limiter a
    // defence rather than just a policy.
    refused_duration: ['p(95)<2000'],
    limited_rate: ['rate>=0'],
    // 5xx and dropped connections only — 429s are already accounted healthy above.
    http_req_failed: ['rate<0.01'],
    checks: ['rate>0.99'],
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
  // Per-VU, so the fake's deterministic latency spreads across the population instead of
  // every virtual user drawing the same delay from the same hash.
  const artifact = `spike artifact for vu ${__VU} iteration ${__ITER}`

  const res = evaluate(artifact)

  const body = json(res)

  limitedRate.add(res.status === 429)
  if (res.status === 200) servedDuration.add(res.timings.duration)
  if (res.status === 429) refusedDuration.add(res.timings.duration)

  check(res, {
    // The claim the spike is really testing: at the cliff every request is either served or
    // cleanly refused. A 503 or a 504 here means the API took work it could not finish,
    // which is the failure mode the limiter is supposed to make impossible.
    'served or cleanly refused — never dropped': (r) => r.status === 200 || r.status === 429,
    'carries a request_id even at the cliff': () => typeof body?.request_id === 'string',
  })

  if (res.status === 429) {
    check(
      res,
      {
        'a refusal is still well-formed under a step change': () =>
          body?.error?.code === 'RATE_LIMITED' && Number(res.headers['Retry-After']) > 0,
      },
      { kind: 'limited' },
    )
  }
}
