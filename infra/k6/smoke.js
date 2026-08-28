import { check } from 'k6'
import http from 'k6/http'

/**
 * The smoke test (SENIORITY_CHECKLIST 5). One virtual user, one pass, asserting that the
 * composed stack actually works — not how fast it is. Ramp, spike, soak and the
 * BREAKING_POINT document are M2; running them now would produce numbers about a fake
 * provider, which is a benchmark of a hash function.
 *
 * It runs from the `grafana/k6` container under a compose profile, never a host install,
 * so "can I run the load test" has the same answer on every machine.
 *
 * What it is really for: it is the one check that exercises the whole thread the way a
 * customer does — over the network, through the published port, against a stack that was
 * migrated and seeded by the same `docker compose up` a reader is told to run. Every unit
 * test in this repo passes with the containers cold.
 */

const BASE = __ENV.API_BASE_URL || 'http://api:3000'
const PANEL = __ENV.PANEL_ID || 'pnl_000000000000000000SEEDPANE'
const KEY = __ENV.API_KEY || `llk_test_${'0'.repeat(64)}`

/** The seeded panel's judges, in the order the seed declares them. */
const JUDGES = ['is-bug', 'is-feature', 'is-question', 'needs-human']

/**
 * `http_req_failed` counts any 4xx or 5xx as a failure, and two of the checks below EXPECT
 * one — a malformed body must be a 422 and a missing key must be a 401. Telling k6 which
 * status each request considers healthy is what keeps the threshold `rate==0` honest
 * instead of merely loosened.
 */
const expect = (...statuses) => ({ responseCallback: http.expectedStatuses(...statuses) })

const authed = (extra) => ({
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}` },
  ...extra,
})

export const options = {
  vus: 1,
  iterations: 1,
  thresholds: {
    // Every check must pass. A smoke test with a 99% pass rate is a smoke test that
    // sometimes reports a broken stack as green.
    checks: ['rate==1.00'],
    http_req_failed: ['rate==0.00'],
    // Generous on purpose: this is a correctness gate, and a cold container on a shared CI
    // runner is not a latency measurement. The number that means something arrives at M2.
    http_req_duration: ['p(95)<3000'],
  },
}

const json = (response) => {
  try {
    return response.json()
  } catch {
    return undefined
  }
}

/** Every response, success or failure, carries one (ADR-0010). */
const hasRequestId = (body) => typeof body?.request_id === 'string' && body.request_id.length > 0

export default function () {
  // ---- liveness: no dependency touched, and it says which build it is (ADR-0011) -------
  const healthz = http.get(`${BASE}/healthz`)
  const health = json(healthz)
  check(healthz, {
    'healthz is 200': (r) => r.status === 200,
    'healthz reports ok': () => health?.data?.status === 'ok',
    'healthz names its build': () =>
      typeof health?.data?.version === 'string' && typeof health?.data?.git_sha === 'string',
    'healthz carries a request_id': () => hasRequestId(health),
  })

  // ---- readiness: Postgres, the migration stream, and the queue -------------------------
  const readyz = http.get(`${BASE}/readyz`)
  const ready = json(readyz)
  check(readyz, {
    'readyz is 200': (r) => r.status === 200,
    'readyz reports ready': () => ready?.data?.status === 'ready',
    'readyz checked db, migrations and queue': () =>
      (ready?.data?.checks || []).length === 3 && ready.data.checks.every((c) => c.ok),
  })

  // ---- the product: a panel of judges over one artifact ---------------------------------
  const evaluated = http.post(
    `${BASE}/v1/panels/${PANEL}/evaluate`,
    JSON.stringify({ artifact: 'the login button does nothing on Safari 17' }),
    authed(),
  )
  const evaluation = json(evaluated)
  check(evaluated, {
    'evaluate is 200': (r) => r.status === 200,
    'evaluate returns a decision': () =>
      typeof evaluation?.data?.passed === 'boolean' &&
      typeof evaluation?.data?.threshold === 'number',
    'evaluate ran every seeded judge': () =>
      JUDGES.every((slug) => evaluation?.data?.judges?.[slug] !== undefined),
    'every judge reasoned before it answered': () =>
      JUDGES.every((slug) => {
        const verdict = evaluation?.data?.judges?.[slug]
        return typeof verdict?.rationale === 'string' && verdict.rationale.length > 0
      }),
    'the call was captured as a trace (ADR-0001)': () =>
      typeof evaluation?.data?.trace_id === 'string' && evaluation.data.trace_id.startsWith('tr_'),
    // Not merely present: `request_id` IS the W3C trace id of the serving span (ADR-0010),
    // which is what makes it the string Tempo is indexed by. 32 lowercase hex characters.
    'request_id is a W3C trace id': () => /^[0-9a-f]{32}$/.test(evaluation?.request_id ?? ''),
  })

  // ---- the taxonomy, on real endpoints (ADR-0015) ---------------------------------------
  const malformed = http.post(
    `${BASE}/v1/panels/${PANEL}/evaluate`,
    JSON.stringify({ artifact: '' }),
    authed(expect(422)),
  )
  const invalid = json(malformed)
  check(malformed, {
    'an empty artifact is 422': (r) => r.status === 422,
    'and the body names the code, not the number': () =>
      invalid?.error?.code === 'VALIDATION_ERROR',
    'and points at the field': () => (invalid?.error?.issues || []).length > 0,
  })

  const unauthenticated = http.post(
    `${BASE}/v1/panels/${PANEL}/evaluate`,
    JSON.stringify({ artifact: 'no key' }),
    { headers: { 'content-type': 'application/json' }, ...expect(401) },
  )
  const denied = json(unauthenticated)
  check(unauthenticated, {
    'no key is 401': (r) => r.status === 401,
    'and the code is UNAUTHORIZED': () => denied?.error?.code === 'UNAUTHORIZED',
  })

  // ---- the console is served -------------------------------------------------------------
  const console_ = http.get(__ENV.WEB_BASE_URL || 'http://web:8080/')
  check(console_, {
    'the console is served': (r) => r.status === 200,
    'and it is the SPA shell': (r) => r.body.includes('<div id="root"></div>'),
  })
}
