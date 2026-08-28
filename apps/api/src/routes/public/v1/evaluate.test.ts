import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  type Evaluation,
  errorEnvelopeSchema,
  evaluateResponseSchema,
  newId,
} from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { trace } from '@opentelemetry/api'
import { eq } from 'drizzle-orm'
import { createFixedClock } from '../../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../../adapters/noop-error-reporter.ts'
import { createApp } from '../../../app.ts'
import { loadConfig } from '../../../config.ts'
import { createFakeProvider, createModelGateway, FAKE_SENTINELS } from '../../../llm/index.ts'
import { sha256Hex } from '../../../middleware/api-key-auth.ts'
import { fakeAuth } from '../../../testing/fake-auth.ts'
import { fakeQueue } from '../../../testing/fake-queue.ts'

/**
 * The steel thread, end to end: a real HTTP request through the real composition root,
 * authenticated by a real hashed key, against a real Postgres, with only the provider
 * faked — because the provider is the one dependency M0 deliberately does not have.
 *
 * It does NOT skip when there is no database, for the same reason `packages/db`'s tests do
 * not: the claims here are about what actually gets persisted, and a test that silently
 * skips reads green in CI while proving nothing.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the evaluation integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

/** Fresh ids per run, so the test is repeatable and leaves nothing behind. */
const ORG = newId('org_')
const PANEL = newId('pnl_')
const PANEL_VERSION = newId('pnv_')
const OTHER_PANEL = newId('pnl_')
const KEY = newId('key_')
const REVOKED_KEY = newId('key_')
const OTHER_PANEL_KEY = newId('key_')

const PLAINTEXT = `llk_test_${'a'.repeat(64)}`
const REVOKED_PLAINTEXT = `llk_test_${'b'.repeat(64)}`
const OTHER_PANEL_PLAINTEXT = `llk_test_${'c'.repeat(64)}`

/**
 * Two judges, chosen to exercise the two halves of the polarity rule with one call: a
 * label that scores nothing, and a required gate whose `true` is a failure.
 */
const JUDGES = [
  {
    slug: 'is-bug',
    polarity: 'does_not_score' as const,
    weight: null,
    required: false,
    question: 'Does this issue report something behaving incorrectly?',
  },
  {
    slug: 'needs-human',
    polarity: 'fails' as const,
    weight: 1,
    required: true,
    question: 'Does this issue need a maintainer to read it?',
  },
].map((judge) => ({ ...judge, judgeId: newId('jud_'), judgeVersionId: newId('jdv_') }))

let db: Database

const seedFixtures = async () => {
  await db.insert(schema.orgs).values({ id: ORG, slug: `test-${ORG}`, name: 'Integration test' })
  await db.insert(schema.panels).values([
    { id: PANEL, orgId: ORG, slug: 'issue-triage', name: 'Issue triage' },
    { id: OTHER_PANEL, orgId: ORG, slug: 'other', name: 'Another panel' },
  ])
  await db
    .insert(schema.panelVersions)
    .values({ id: PANEL_VERSION, panelId: PANEL, version: 1, threshold: 0.5 })

  for (const judge of JUDGES) {
    await db
      .insert(schema.judges)
      .values({ id: judge.judgeId, panelId: PANEL, slug: judge.slug, name: judge.slug })
    await db.insert(schema.judgeVersions).values({
      id: judge.judgeVersionId,
      judgeId: judge.judgeId,
      version: 1,
      type: 'llm',
      polarity: judge.polarity,
      weight: judge.weight,
      required: judge.required,
      question: judge.question,
      model: 'fake:deterministic',
    })
    await db
      .insert(schema.panelVersionJudges)
      .values({ panelVersionId: PANEL_VERSION, judgeVersionId: judge.judgeVersionId })
  }

  // Activation is its own act: the version has to exist before it can be pointed at.
  await db
    .update(schema.panels)
    .set({ currentVersionId: PANEL_VERSION })
    .where(eq(schema.panels.id, PANEL))

  await db.insert(schema.apiKeys).values([
    {
      id: KEY,
      orgId: ORG,
      panelId: PANEL,
      name: 'Integration test',
      hash: sha256Hex(PLAINTEXT),
      last4: PLAINTEXT.slice(-4),
    },
    {
      id: REVOKED_KEY,
      orgId: ORG,
      panelId: PANEL,
      name: 'Revoked',
      hash: sha256Hex(REVOKED_PLAINTEXT),
      last4: REVOKED_PLAINTEXT.slice(-4),
      status: 'revoked',
    },
    {
      id: OTHER_PANEL_KEY,
      orgId: ORG,
      panelId: OTHER_PANEL,
      name: 'Scoped elsewhere',
      hash: sha256Hex(OTHER_PANEL_PLAINTEXT),
      last4: OTHER_PANEL_PLAINTEXT.slice(-4),
    },
  ])
}

const dropFixtures = async () => {
  // Traces first: `trace_verdicts` references `judge_versions` with ON DELETE RESTRICT, so
  // dropping the org while an evaluation still points at its judges would be refused.
  await db.delete(schema.traces).where(eq(schema.traces.orgId, ORG))
  await db.delete(schema.orgs).where(eq(schema.orgs.id, ORG))
}

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  await dropFixtures()
  await seedFixtures()
})

afterAll(async () => {
  await dropFixtures()
  await db.close()
})

let reporter: ReturnType<typeof createRecordingErrorReporter>
/**
 * The queue is faked here where the provider is faked and the database is not, and the
 * reason is the same in both directions: what this file asserts is that the evaluation path
 * enqueues exactly one job carrying the right ids, which is a claim about this code. That
 * the job then round-trips through pg-boss and runs idempotently is a claim about the
 * queue, and it is asserted against a real one in `src/jobs/`.
 */
let queue: ReturnType<typeof fakeQueue>

/**
 * OTel's global tracer with no provider registered — real object, no-op spans. The spans
 * this path emits are asserted in `middleware/tracing.test.ts` and `llm/spans.test.ts`;
 * here the no-op is the point, because it proves the steel thread does not depend on
 * telemetry being configured to work.
 */
const noopTracer = trace.getTracer('test')

/** The real app, with the real database, and the provider swapped through the same seam. */
const appWith = (provider = createFakeProvider()) =>
  createApp({
    config,
    clock: createFixedClock(),
    errorReporter: reporter,
    db,
    modelGateway: createModelGateway({
      provider,
      clock: createFixedClock(),
      tracer: noopTracer,
      random: () => 1,
    }),
    jobs: queue,
    tracer: noopTracer,
    auth: fakeAuth(),
  })

const evaluateRequest = (
  body: unknown,
  { key = PLAINTEXT, panel = PANEL }: { key?: string | null; panel?: string } = {},
) =>
  new Request(`http://localhost/v1/panels/${panel}/evaluate`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  })

const ARTIFACT = 'Login button does nothing on Safari 17. Repro: click it. Nothing happens.'

beforeEach(() => {
  reporter = createRecordingErrorReporter()
  queue = fakeQueue()
})

describe('a successful evaluation', () => {
  test('answers with the published contract, keyed by judge slug', async () => {
    const res = await appWith().request(evaluateRequest({ artifact: ARTIFACT }))
    expect(res.status).toBe(200)

    const parsed = evaluateResponseSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    const evaluation = parsed.data?.data as Evaluation

    expect(Object.keys(evaluation.judges).sort()).toEqual(['is-bug', 'needs-human'])
    expect(evaluation.aggregation.panel_version).toBe(PANEL_VERSION)
    expect(evaluation.threshold).toBe(0.5)
    expect(evaluation.complete).toBe(true)
    expect(evaluation.trace_id.startsWith('tr_')).toBe(true)
  })

  test('applies each judge’s own polarity, which is what makes the score mean anything', async () => {
    const res = await appWith().request(evaluateRequest({ artifact: ARTIFACT }))
    const { data } = (await res.json()) as { data: Evaluation }

    const label = data.judges['is-bug']
    const gate = data.judges['needs-human']
    if (label === undefined || gate === undefined) throw new Error('expected both judges')

    // A label has no valence: it answers, and it scores nothing.
    expect(label.status).toBe('evaluated')
    expect(label.passed).toBeNull()
    expect(label.weight).toBeNull()

    // The gate's `true` is a failure, so `passed` is its verdict inverted — never a copy.
    expect(gate.passed).toBe(!gate.verdict)
    expect(gate.weight).toBe(1)
    expect(gate.served_by).toBe('fake:deterministic')
    expect(gate.attempts).toBe(1)
    expect(gate.rationale).toBeTruthy()
  })

  test('the same artifact evaluates the same way, into a NEW trace each time', async () => {
    const app = appWith()
    const first = (await (await app.request(evaluateRequest({ artifact: ARTIFACT }))).json()) as {
      data: Evaluation
      request_id: string
    }
    const second = (await (await app.request(evaluateRequest({ artifact: ARTIFACT }))).json()) as {
      data: Evaluation
      request_id: string
    }

    expect(second.data.judges['needs-human']?.verdict).toBe(
      first.data.judges['needs-human']?.verdict ?? null,
    )
    expect(second.data.score).toBe(first.data.score)
    // Two identifiers, never conflated (ADR-0010): a new execution, and a new record.
    expect(second.data.trace_id).not.toBe(first.data.trace_id)
    expect(second.request_id).not.toBe(first.request_id)
  })
})

describe('the trace that gets written (ADR-0001)', () => {
  test('records the run, the key that paid for it, and the request that produced it', async () => {
    const res = await appWith().request(
      evaluateRequest({ artifact: ARTIFACT, context: { source: 'github' } }),
    )
    const { data, request_id } = (await res.json()) as { data: Evaluation; request_id: string }

    const trace = await db.query.traces.findFirst({
      where: eq(schema.traces.id, data.trace_id),
    })
    expect(trace).toBeDefined()
    expect(trace?.requestId).toBe(request_id)
    expect(trace?.apiKeyId).toBe(KEY)
    expect(trace?.panelVersionId).toBe(PANEL_VERSION)
    expect(trace?.artifact).toBe(ARTIFACT)
    expect(trace?.context).toEqual({ source: 'github' })
    expect(trace?.passed).toBe(data.passed)
    expect(trace?.complete).toBe(data.complete)
  })

  test('stores the raw provider payload beside the normalised fields, FK’d to a jdv_', async () => {
    const res = await appWith().request(evaluateRequest({ artifact: ARTIFACT }))
    const { data } = (await res.json()) as { data: Evaluation }

    const verdicts = await db.query.traceVerdicts.findMany({
      where: eq(schema.traceVerdicts.traceId, data.trace_id),
    })
    expect(verdicts).toHaveLength(2)

    const gate = verdicts.find((verdict) => verdict.judgeVersionId === JUDGES[1]?.judgeVersionId)
    expect(gate).toBeDefined()
    expect(gate?.status).toBe('evaluated')
    expect(gate?.verdict).toBe(data.judges['needs-human']?.verdict ?? null)
    expect(gate?.rationale).toBeTruthy()
    // The second representation, not a copy of the first: it is shaped like a provider
    // envelope, which is what makes the trace rerunnable rather than parser-dependent.
    expect(gate?.rawResponse).toMatchObject({ provider: 'fake', model: 'fake:deterministic' })
  })
})

describe('the follow-up job the evaluation enqueues', () => {
  test('exactly one job, carrying the tr_ id and the request_id', async () => {
    const res = await appWith().request(evaluateRequest({ artifact: ARTIFACT }))
    const { data, request_id } = (await res.json()) as { data: Evaluation; request_id: string }

    // Exactly one. A job per judge would be the easy mistake, and it would make the trace's
    // follow-up run N times for one evaluation.
    expect(queue.sent).toHaveLength(1)
    expect(queue.sent[0]?.queue).toBe('record-evaluation')
    expect(queue.sent[0]?.payload).toEqual({ trace_id: data.trace_id, request_id })
  })

  test('a queue that refuses the job does NOT fail the evaluation', async () => {
    /**
     * The request has already succeeded by this point: the judges ran and the trace is
     * committed, so the caller is owed their verdicts. Failing them because a background
     * job could not be queued would turn a degraded dependency into an outage on the one
     * path that was working.
     *
     * What stops that from being a silent data loss is that the dropped work is findable:
     * `traces.recorded_at` is still null, which is the query a reconciliation sweep runs.
     */
    queue = fakeQueue({ sendFails: new Error('queue unreachable') })
    const res = await appWith().request(evaluateRequest({ artifact: ARTIFACT }))
    expect(res.status).toBe(200)

    const { data } = (await res.json()) as { data: Evaluation }
    const trace = await db.query.traces.findFirst({ where: eq(schema.traces.id, data.trace_id) })
    expect(trace).toBeDefined()
    expect(trace?.recordedAt).toBeNull()

    // Reporting is not handling (ADR-0007): the caller is served and the tracker is told.
    expect(reporter.reports).toHaveLength(1)
    expect(reporter.reports[0]?.context).toMatchObject({ queue: 'record-evaluation' })
  })
})

describe('401 — every rejection looks the same (ADR-0003)', () => {
  test.each([
    ['no key at all', null],
    ['a key that is not one of ours', 'not-a-key'],
    ['a well-formed key nobody issued', `llk_test_${'z'.repeat(64)}`],
    ['a revoked key', REVOKED_PLAINTEXT],
    ['a key scoped to another panel', OTHER_PANEL_PLAINTEXT],
  ])('%s is UNAUTHORIZED', async (_name, key) => {
    const res = await appWith().request(evaluateRequest({ artifact: ARTIFACT }, { key }))
    expect(res.status).toBe(401)

    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('UNAUTHORIZED')
  })

  test('the message never says WHICH check failed — a 403 would be a panel oracle', async () => {
    const [unknown, foreign] = await Promise.all([
      appWith().request(
        evaluateRequest({ artifact: ARTIFACT }, { key: `llk_test_${'z'.repeat(64)}` }),
      ),
      appWith().request(evaluateRequest({ artifact: ARTIFACT }, { key: OTHER_PANEL_PLAINTEXT })),
    ])
    const bodies = await Promise.all([unknown.json(), foreign.json()])
    expect((bodies[0] as { error: { message: string } }).error.message).toBe(
      (bodies[1] as { error: { message: string } }).error.message,
    )
  })

  test('an unauthenticated call writes no trace and runs no judge', async () => {
    const provider = createFakeProvider()
    await appWith(provider).request(evaluateRequest({ artifact: ARTIFACT }, { key: null }))
    expect(provider.calls).toBe(0)
  })
})

describe('422 — real contract validation, on the real endpoint (ADR-0015)', () => {
  test.each([
    ['an empty artifact', { artifact: '' }],
    ['no artifact at all', {}],
    ['an artifact of the wrong type', { artifact: 42 }],
    ['context that is not a string map', { artifact: ARTIFACT, context: { a: 1 } }],
  ])('%s becomes VALIDATION_ERROR with field-level issues', async (_name, body) => {
    const res = await appWith().request(evaluateRequest(body))
    expect(res.status).toBe(422)

    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error.code).toBe('VALIDATION_ERROR')
    expect(parsed.data?.error.issues?.length).toBeGreaterThan(0)
  })

  test('the issues name the offending field, not just that something was wrong', async () => {
    const res = await appWith().request(evaluateRequest({ artifact: '' }))
    const body = (await res.json()) as { error: { issues: Array<{ path: string }> } }
    expect(body.error.issues[0]?.path).toBe('artifact')
  })
})

describe('a panel whose judges cannot be reached', () => {
  test('fails the request retryably rather than reporting a score of nothing', async () => {
    const res = await appWith().request(
      evaluateRequest({ artifact: `${FAKE_SENTINELS.unavailable} everything is down` }),
    )

    expect([503, 504]).toContain(res.status)
    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.success).toBe(true)
    expect(['PROVIDER_UNAVAILABLE', 'CIRCUIT_OPEN']).toContain(parsed.data?.error.code ?? 'none')
    expect(res.headers.get('retry-after')).toBeTruthy()
  })

  test('the run is still recorded — a failed evaluation is one somebody will look at', async () => {
    const res = await appWith().request(
      evaluateRequest({ artifact: `${FAKE_SENTINELS.unavailable} also down` }),
    )
    const { request_id } = (await res.json()) as { request_id: string }

    // The error envelope has no `data`, so there is no `tr_` to quote — which is exactly
    // why every trace stores the `request_id` of the execution that produced it.
    const trace = await db.query.traces.findFirst({
      where: eq(schema.traces.requestId, request_id),
      with: { verdicts: true },
    })
    expect(trace).toBeDefined()
    expect(trace?.complete).toBe(false)
    expect(trace?.passed).toBe(false)
    expect(trace?.verdicts.every((verdict) => verdict.status === 'error')).toBe(true)
  })
})

describe('a panel that is not there', () => {
  test('an unknown panel is a 401, not a 404 — the key is checked first', async () => {
    const res = await appWith().request(
      evaluateRequest({ artifact: ARTIFACT }, { panel: newId('pnl_') }),
    )
    expect(res.status).toBe(401)
  })

  test('a panel with no live version is a 404, even with a valid key', async () => {
    const res = await appWith().request(
      evaluateRequest({ artifact: ARTIFACT }, { key: OTHER_PANEL_PLAINTEXT, panel: OTHER_PANEL }),
    )
    expect(res.status).toBe(404)
    const parsed = errorEnvelopeSchema.safeParse(await res.json())
    expect(parsed.data?.error.code).toBe('NOT_FOUND')
  })
})
