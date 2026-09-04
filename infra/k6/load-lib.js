import http from 'k6/http'

/**
 * Shared by `ramp.js` and `spike.js`, and deliberately NOT by `smoke.js` — the smoke test
 * is CI's gate and stays self-contained, because a shared module is one more thing that can
 * break the one script that has to work.
 *
 * What is in here is the setup guard, and it exists because of a specific, silent failure
 * (see `assertJudgesAreSlow`).
 *
 * These files run in k6's runtime, not ours, which is why `biome.json` turns off the
 * `noConsole` ban for `infra/k6/**`. That rule protects the API's structured logging — one
 * pino logger, `request_id` on every line, no stray writes to stdout (CONVENTIONS.md
 * "Logging"). None of that exists here: k6 has no logger, and `console.log` is the only
 * channel a script has to say anything to the operator running it.
 */

export const BASE = __ENV.API_BASE_URL || 'http://api:3000'
export const PANEL = __ENV.PANEL_ID || 'pnl_000000000000000000SEEDPANE'
export const KEY = __ENV.API_KEY || `llk_test_${'0'.repeat(64)}`

/**
 * `http_req_failed` counts any 4xx or 5xx as a failure, and a load run is EXPECTED to
 * produce 429s — that is the limiter working, not the system breaking. Telling k6 which
 * statuses each request considers healthy keeps the threshold meaningful rather than merely
 * loosened, the same honesty `smoke.js` already applies to its deliberate 401 and 422.
 *
 * 503 and 504 are deliberately NOT here. A tripped breaker or a gateway timeout is the
 * system failing to serve, which is exactly what a load run exists to find; folding them in
 * would let a run stay green through the very event it is looking for.
 */
export const EXPECTED = { responseCallback: http.expectedStatuses(200, 429) }

export const authed = {
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}` },
  ...EXPECTED,
}

export const json = (response) => {
  try {
    return response.json()
  } catch {
    return undefined
  }
}

export const evaluate = (artifact) =>
  http.post(`${BASE}/v1/panels/${PANEL}/evaluate`, JSON.stringify({ artifact }), authed)

/** Below this, the fake is answering from a hash rather than impersonating a judge. */
const PLAUSIBLE_JUDGE_MS = 500

/**
 * **Refuse to run against a zero-latency fake.** This guard is here because of a failure
 * that happened, not one that was imagined.
 *
 * `docker compose --profile k6 run` evaluates the whole dependency graph, and a service
 * whose environment differs from the running container is considered out of date and gets
 * RECREATED. So an operator who brings the stack up with the latency knob set and then runs
 * k6 without repeating it silently restarts the API at zero latency — and the run measures
 * the throughput of a hash function while reporting a wonderful p95. Measured on
 * 2026-09-04: `served_duration` p95 of 73ms against a fake configured for 4000ms. Nothing
 * failed; the numbers were simply about nothing. (`ci.yml`'s k6 step documents the same
 * trap for its build args, which is how it was recognised.)
 *
 * The fix is to repeat the variables on the k6 command, and the guard is here so that
 * forgetting is loud rather than invisible:
 *
 *   FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \
 *     docker compose -f infra/docker-compose.yml --profile k6 run --rm k6 run /scripts/ramp.js
 *
 * Skippable with `ALLOW_FAST_JUDGE=1`, for the one legitimate case: deliberately measuring
 * the limiter's own cost, where the dependency's speed is beside the point.
 */
export const assertJudgesAreSlow = () => {
  if (__ENV.ALLOW_FAST_JUDGE === '1') return { checked: false }

  const probe = evaluate('setup probe: is the judge behaving like a judge?')

  if (probe.status === 429) {
    // The bucket is already empty from a previous run. Not a reason to abort — but not a
    // reason to claim the check passed either, so say which it was.
    return { checked: false, reason: 'rate limited during setup, latency unverified' }
  }

  if (probe.status !== 200) {
    throw new Error(
      `setup probe got ${probe.status} from ${BASE}. The stack is not serving — bring it up ` +
        'with `docker compose -f infra/docker-compose.yml up -d --wait` first.',
    )
  }

  if (probe.timings.duration < PLAUSIBLE_JUDGE_MS) {
    throw new Error(
      `The judge answered in ${Math.round(probe.timings.duration)}ms, which is not a judge — ` +
        'it is a hash. This run would measure nothing.\n\n' +
        'The API is almost certainly running at FAKE_PROVIDER_LATENCY_MS=0, most likely ' +
        'because `compose run` recreated it: a service whose environment differs from the ' +
        'running container is considered out of date and restarted. Repeat the variables on ' +
        'this command:\n\n' +
        '  FAKE_PROVIDER_LATENCY_MS=4000 FAKE_PROVIDER_LATENCY_SPREAD_MS=1500 \\\n' +
        '    docker compose -f infra/docker-compose.yml --profile k6 run --rm k6 run ' +
        '/scripts/ramp.js\n\n' +
        'Set ALLOW_FAST_JUDGE=1 if you genuinely mean to measure the limiter alone.',
    )
  }

  return { checked: true, probeMs: Math.round(probe.timings.duration) }
}
