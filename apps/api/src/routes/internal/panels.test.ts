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
