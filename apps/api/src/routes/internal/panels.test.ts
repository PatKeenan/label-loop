import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, errorEnvelopeSchema, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { metrics, trace } from '@opentelemetry/api'
import { eq } from 'drizzle-orm'
import { createFixedClock } from '../../adapters/fixed-clock.ts'
import { createRecordingErrorReporter } from '../../adapters/noop-error-reporter.ts'
import { createApp } from '../../app.ts'
import { createAuth } from '../../auth.ts'
import { loadConfig } from '../../config.ts'
import { createFakeProvider, createModelGateway, FAKE_MODEL } from '../../llm/index.ts'
import { type ModelProvider, ProviderError } from '../../llm/provider.port.ts'
import { sha256Hex } from '../../middleware/api-key-auth.ts'
import { createMemoryRateLimitStore } from '../../rate-limit/memory-store.ts'
import { fakeCatalogue } from '../../testing/fake-catalogue.ts'
import { fakeQueue } from '../../testing/fake-queue.ts'

/**
 * `/internal/panels`, end to end — and the test M4's demo moment rests on: **a panel created
 * through this API, with a key issued through phase 3's API, answering `POST /v1/panels/{id}/
 * evaluate`, with no seed involved at any step.** Until this phase, every object in that chain
 * existed in the schema and had no write path outside `scripts/seed.ts`.
 *
 * Real Postgres, real better-auth, real sessions. The only fakes are the provider and the queue.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the panels integration test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const config = loadConfig({ LOG_LEVEL: 'silent', DATABASE_URL })

const ORG = newId('org_')
const OTHER_ORG = newId('org_')
const ADMIN_EMAIL = `panels-admin-${ORG}@labelloop.test`.toLowerCase()
const ANNOTATOR_EMAIL = `panels-annotator-${ORG}@labelloop.test`.toLowerCase()
const PASSWORD = 'localdev-password'

let db: Database
let auth: ReturnType<typeof createAuth>

const noopTracer = trace.getTracer('test')
const noopMeter = metrics.getMeter('test')

/** Fails one `openrouter:` id so a pin can be refused through the route, offline. */
const refusingProvider: ModelProvider = {
  name: 'refusing',
  evaluate: async () => {
    throw new ProviderError('unavailable', 'nothing routes under this pin')
  },
}

const app = (modelProvider: ModelProvider = createFakeProvider()) =>
  createApp({
    config,
    clock: createFixedClock(),
    errorReporter: createRecordingErrorReporter(),
    db,
    modelGateway: createModelGateway({
      provider: createFakeProvider(),
      clock: createFixedClock(),
      tracer: noopTracer,
      meter: noopMeter,
    }),
    modelProvider,
    catalogue: fakeCatalogue(),
    jobs: fakeQueue(),
    tracer: noopTracer,
    meter: noopMeter,
    auth,
    rateLimitStore: createMemoryRateLimitStore(),
  })

const signUp = async (email: string) => {
  const response = await app().request('http://localhost/internal/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: 'Test person' }),
  })
  expect(response.status).toBe(200)
}

const signIn = async (email: string): Promise<string> => {
  const response = await app().request('http://localhost/internal/auth/sign-in/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  expect(response.status).toBe(200)
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

const grantMembership = async (email: string, orgId: string, role: 'admin' | 'annotator') => {
  const rows = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email))
  const userId = rows[0]?.id
  if (userId === undefined) throw new Error(`no user for ${email}`)
  await db.insert(schema.orgMembers).values({ orgId, userId, role }).onConflictDoNothing()
}

const fakeJudge = (overrides: Record<string, unknown> = {}) => ({
  slug: 'is-missing-repro',
  name: 'Missing repro',
  type: 'llm',
  question: 'Does this issue lack reproduction steps?',
  polarity: 'fails',
  weight: 1,
  required: false,
  model: FAKE_MODEL,
  pin: DEFAULT_FAKE_PIN,
  ...overrides,
})

const panelBody = (slug: string, judges: unknown[] = [fakeJudge()]) => ({
  slug,
  name: `Panel ${slug}`,
  threshold: 0.5,
  judges,
})

const postPanel = (cookie: string, body: unknown, provider?: ModelProvider) =>
  app(provider).request('http://localhost/internal/panels', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

type Issues = { path: string; message: string }[]
const issuesOf = async (response: Response): Promise<Issues> => {
  const parsed = errorEnvelopeSchema.safeParse(await response.json())
  expect(parsed.data?.error.code).toBe('VALIDATION_ERROR')
  return (parsed.data?.error as { issues?: Issues } | undefined)?.issues ?? []
}

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  auth = createAuth(db, config)
  await db.insert(schema.orgs).values([
    { id: ORG, slug: `panels-${ORG}`, name: 'Panels test' },
    { id: OTHER_ORG, slug: `panels-${OTHER_ORG}`, name: 'Somebody else' },
  ])
  await signUp(ADMIN_EMAIL)
  await grantMembership(ADMIN_EMAIL, ORG, 'admin')
  await signUp(ANNOTATOR_EMAIL)
  await grantMembership(ANNOTATOR_EMAIL, ORG, 'annotator')
})

afterAll(async () => {
  for (const org of [ORG, OTHER_ORG]) await db.delete(schema.orgs).where(eq(schema.orgs.id, org))
  for (const email of [ADMIN_EMAIL, ANNOTATOR_EMAIL]) {
    await db.delete(schema.user).where(eq(schema.user.email, email))
  }
  await db.close()
})

describe('M4’s demo moment, with no seed', () => {
  test('create a panel → issue a key → evaluate it on /v1', async () => {
    const cookie = await signIn(ADMIN_EMAIL)

    // 1. The panel, through the console API.
    const created = await postPanel(cookie, panelBody('end-to-end'))
    expect(created.status).toBe(201)
    const panel = (await created.json()) as { data: { panel_id: string; active: boolean } }
    expect(panel.data.active).toBe(true)

    // 2. A key for it, through phase 3's API.
    const keyResponse = await app().request('http://localhost/internal/keys', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ panel_id: panel.data.panel_id, name: 'End to end' }),
    })
    expect(keyResponse.status).toBe(201)
    const key = ((await keyResponse.json()) as { data: { key: string } }).data.key

    // 3. The public API, with that key, against that panel.
    const evaluated = await app().request(
      `http://localhost/v1/panels/${panel.data.panel_id}/evaluate`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ artifact: 'Login button does nothing on Safari 17.' }),
      },
    )

    // 200, not 404: the panel is LIVE, because version 1 was activated in the transaction that
    // wrote it. Every earlier `/v1` test in this repo ran against `scripts/seed.ts`'s panel.
    expect(evaluated.status).toBe(200)
    const body = (await evaluated.json()) as {
      data: { judges: Record<string, unknown>; trace_id: string }
    }
    expect(Object.keys(body.data.judges)).toEqual(['is-missing-repro'])
    expect(body.data.trace_id).toMatch(/^tr_/)
  })
})

describe('form errors land on the field that caused them', () => {
  test('an unsatisfiable pin is a 422 at judges.N.model, with the reason verbatim', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await postPanel(
      cookie,
      panelBody('bad-pin', [
        fakeJudge(),
        fakeJudge({ slug: 'is-p0', model: 'openrouter:anthropic/claude-haiku-4.5' }),
      ]),
      refusingProvider,
    )

    expect(response.status).toBe(422)
    const issues = await issuesOf(response)
    // Index 1, not 0: the `fake:` judge validated; only the refused one is reported.
    expect(issues).toEqual([
      { path: 'judges.1.model', message: expect.stringContaining('no endpoint could serve') },
    ])
    const rows = await db.select().from(schema.panels).where(eq(schema.panels.slug, 'bad-pin'))
    expect(rows).toHaveLength(0)
  })

  test('a `code` judge is refused at judges.N.type, saying why', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await postPanel(cookie, panelBody('code-judge', [fakeJudge({ type: 'code' })]))

    expect(response.status).toBe(422)
    const issues = await issuesOf(response)
    // A judge that cannot run, with no column for what it would check, and a veto if marked
    // required — refused with the reason rather than silently narrowed to `llm`.
    expect(issues[0]?.path).toBe('judges.0.type')
    expect(issues[0]?.message).toContain('M5')
  })

  test('a duplicate judge slug is refused at judges.N.slug, before Postgres sees it', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await postPanel(cookie, panelBody('dupe', [fakeJudge(), fakeJudge()]))

    expect(response.status).toBe(422)
    expect((await issuesOf(response))[0]?.path).toBe('judges.1.slug')
  })

  test('a taken panel slug is refused at `slug`', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    expect((await postPanel(cookie, panelBody('taken'))).status).toBe(201)

    const again = await postPanel(cookie, panelBody('taken'))
    expect(again.status).toBe(422)
    expect((await issuesOf(again))[0]?.path).toBe('slug')
  })

  test.each([
    ['weight 0', { weight: 0 }, 'judges.0.weight'],
    ['a polarity that is neither', { polarity: 'sometimes' }, 'judges.0.polarity'],
    ['a slug that is not kebab-case', { slug: 'Is_P0' }, 'judges.0.slug'],
  ])('%s is a 422 at the field', async (_label, override, path) => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await postPanel(cookie, panelBody('field', [fakeJudge(override)]))
    expect(response.status).toBe(422)
    expect((await issuesOf(response)).map((issue) => issue.path)).toContain(path)
  })

  test('more judges than the ceiling is refused — each one is a paid validating call', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const judges = Array.from({ length: 17 }, (_, i) => fakeJudge({ slug: `judge-${i}` }))
    expect((await postPanel(cookie, panelBody('too-many', judges))).status).toBe(422)
  })
})

describe('tenancy and roles', () => {
  test('the list shows this org’s panels and never another’s', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    await postPanel(cookie, panelBody('mine'))
    const theirs = newId('pnl_')
    await db
      .insert(schema.panels)
      .values({ id: theirs, orgId: OTHER_ORG, slug: 'theirs', name: 'Theirs' })

    const response = await app().request('http://localhost/internal/panels', {
      headers: { cookie },
    })
    const body = (await response.json()) as { data: { panels: { id: string; slug: string }[] } }
    expect(body.data.panels.map((panel) => panel.slug)).toContain('mine')
    expect(body.data.panels.map((panel) => panel.id)).not.toContain(theirs)
  })

  test('an annotator can neither create nor list', async () => {
    const cookie = await signIn(ANNOTATOR_EMAIL)
    expect((await postPanel(cookie, panelBody('annotator'))).status).toBe(403)
    expect(
      (await app().request('http://localhost/internal/panels', { headers: { cookie } })).status,
    ).toBe(403)
  })
})

/**
 * ADR-0060 and ADR-0061 — a panel is created COLLECTING, with a key, in one step.
 *
 * Both changes removed a requirement that **nothing asserted**: `judges` used to be
 * `min(1)`, and no test checked it, so making it optional broke nothing. These are the tests
 * for the path the console actually takes at M4, where it sends no judges at all.
 */
describe('a panel created with no judges', () => {
  const collectingBody = (slug: string) => ({
    slug,
    name: `Panel ${slug}`,
    threshold: 0.5,
    // No `judges` key at all — not an empty array. The console omits it, so the default is
    // what has to work, and a test passing `[]` would not prove that.
  })

  test('is created, reports itself collecting, and is live immediately', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await postPanel(cookie, collectingBody('collects'))
    expect(response.status).toBe(201)

    const { data } = (await response.json()) as {
      data: { panel_id: string; state: string; active: boolean; judges: unknown[] }
    }
    expect(data.state).toBe('collecting')
    expect(data.judges).toEqual([])
    // Version 1 is activated in the same transaction: a panel that cannot be called is not
    // a panel anyone can start collecting with.
    expect(data.active).toBe(true)
  })

  test('comes with a key, and the plaintext is returned exactly once', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await postPanel(cookie, collectingBody('with-key'))

    const { data } = (await response.json()) as {
      data: { panel_id: string; key: { id: string; last4: string; plaintext: string } | null }
    }
    expect(data.key).not.toBeNull()
    const key = data.key
    if (key === null) throw new Error('a created panel carries its key')

    // The onboarding snippet needs a credential in it, so this is the whole point.
    expect(key.plaintext.startsWith('llk_test_')).toBe(true)
    expect(key.plaintext.endsWith(key.last4)).toBe(true)

    // Only the HASH is stored. A key readable back out of the database would make "shown
    // once" a claim rather than a property.
    const [row] = await db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, key.id))
    expect(row?.panelId).toBe(data.panel_id)
    expect(row?.hash).toBe(sha256Hex(key.plaintext))
    expect(JSON.stringify(row)).not.toContain(key.plaintext)
  })

  test('and that key can immediately evaluate the panel it was issued with', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const created = await postPanel(cookie, collectingBody('runnable'))
    const { data } = (await created.json()) as {
      data: { panel_id: string; key: { plaintext: string } | null }
    }
    const plaintext = data.key?.plaintext
    if (plaintext === undefined) throw new Error('a created panel carries its key')

    // The snippet the console hands over, driven exactly as a person would paste it.
    const response = await app().request(`http://localhost/v1/panels/${data.panel_id}/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ artifact: 'the agent’s output' }),
    })

    expect(response.status).toBe(200)
    const evaluation = (await response.json()) as { data: { state: string; passed: null } }
    expect(evaluation.data.state).toBe('collecting')
    expect(evaluation.data.passed).toBeNull()
  })

  test('the panel and its key are one transaction — neither exists without the other', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    // A taken slug fails AFTER the panel insert is attempted, so if the key were issued
    // outside the transaction this would leave an orphan credential behind.
    await postPanel(cookie, collectingBody('atomic'))
    const before = await db.select().from(schema.apiKeys)

    const conflict = await postPanel(cookie, collectingBody('atomic'))
    expect(conflict.status).toBe(422)

    const after = await db.select().from(schema.apiKeys)
    expect(after.length).toBe(before.length)
  })
})

/**
 * `GET /internal/panels/:slug` — the panel's Overview and its Judges section in one read.
 */
describe('reading one panel', () => {
  const getPanel = (cookie: string, slug: string) =>
    app().request(`http://localhost/internal/panels/${slug}`, { headers: { cookie } })

  test('reports collecting, its trace count, and no judges', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    await postPanel(cookie, { slug: 'readable', name: 'Readable', threshold: 0.5 })

    const { data } = (await (await getPanel(cookie, 'readable')).json()) as {
      data: { state: string; trace_count: number; judges: unknown[]; threshold: number }
    }
    expect(data.state).toBe('collecting')
    expect(data.judges).toEqual([])
    expect(data.threshold).toBe(0.5)
    // What the Overview counts toward the annotation gate (ADR-0061).
    expect(data.trace_count).toBe(0)
  })

  test('reports its judges, read-only, once it has them', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    await postPanel(cookie, panelBody('judged-read'))

    const { data } = (await (await getPanel(cookie, 'judged-read')).json()) as {
      data: { state: string; judges: { slug: string; question: string; model: string }[] }
    }
    expect(data.state).toBe('judged')
    expect(data.judges.length).toBe(1)
    expect(data.judges[0]?.slug).toBeDefined()
    expect(data.judges[0]?.question).toBeDefined()
  })

  test('counts a trace the panel actually captured', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const created = await postPanel(cookie, { slug: 'counts', name: 'Counts', threshold: 0.5 })
    const { data } = (await created.json()) as {
      data: { panel_id: string; key: { plaintext: string } | null }
    }
    const plaintext = data.key?.plaintext
    if (plaintext === undefined) throw new Error('a created panel carries its key')

    await app().request(`http://localhost/v1/panels/${data.panel_id}/evaluate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${plaintext}`, 'content-type': 'application/json' },
      body: JSON.stringify({ artifact: 'one' }),
    })

    const read = (await (await getPanel(cookie, 'counts')).json()) as {
      data: { trace_count: number }
    }
    // A COLLECTING trace counts. The gate is about how much an expert has to read, and a
    // trace with no verdict is exactly the kind they read first.
    expect(read.data.trace_count).toBe(1)
  })

  test('another org’s panel is NOT_FOUND, never FORBIDDEN', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const theirs = newId('pnl_')
    await db
      .insert(schema.panels)
      .values({ id: theirs, orgId: OTHER_ORG, slug: 'not-yours', name: 'Not yours' })

    const response = await getPanel(cookie, 'not-yours')
    // 404 and not 403: a 403 would confirm the panel exists, which is the same posture
    // ADR-0057 takes for orgs.
    expect(response.status).toBe(404)
    const parsed = errorEnvelopeSchema.safeParse(await response.json())
    expect(parsed.data?.error.code).toBe('NOT_FOUND')
  })

  test('a slug that does not exist is the SAME answer', async () => {
    const cookie = await signIn(ADMIN_EMAIL)
    const response = await getPanel(cookie, 'no-such-panel-anywhere')
    expect(response.status).toBe(404)
  })

  test('an annotator cannot read one', async () => {
    const cookie = await signIn(ANNOTATOR_EMAIL)
    expect((await getPanel(cookie, 'readable')).status).toBe(403)
  })
})
