import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, newId } from '@labelloop/contracts'
import { createDatabase, type Database, schema } from '@labelloop/db'
import { eq, inArray } from 'drizzle-orm'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { FAKE_MODEL } from '../llm/fake-provider.ts'
import { type ModelProvider, ProviderError } from '../llm/provider.port.ts'
import { insertJudge, insertJudgeVersion, insertPanel } from '../repositories/panels.ts'
import { createPanel, type NewJudgeInput } from './create-panel.ts'

/**
 * The first write path for immutable versions — against real Postgres, because every claim
 * this phase makes is a claim about ROWS: that a rejected pin writes none, that a failure
 * halfway through writes none, and that the database itself refuses a meaningless judge.
 *
 * The provider is a stub injected through the port (ADR-0028), not the fake. `validatePin`
 * short-circuits every `fake:` route before calling a provider, so the fake can only ever
 * say yes; the stub is what lets a pin fail through the real validation path, and succeed
 * with a real endpoint count, without spending money.
 *
 * Like the rest of the database-backed tests, it does NOT skip when there is no Postgres.
 */

const DATABASE_URL = (() => {
  const url = process.env.DATABASE_URL
  if (url === undefined || url === '') {
    throw new Error(
      'DATABASE_URL is not set — the create-panel test needs a running Postgres.\n' +
        'Run: bun run db:up && bun run db:setup   (or copy .env.example to .env)',
    )
  }
  return url
})()

const ORG = newId('org_')
let db: Database

/**
 * Answers for three `openrouter:` model ids. **The route has to be a real one**: `modelRefOf`
 * accepts only registered routes (`fake`, `openrouter`), and a first draft of this file used
 * `stub:good` — which was rejected as malformed before the provider was ever called, so every
 * test here was silently exercising the wrong failure. `fake:` cannot be used either, because
 * `validatePin` short-circuits it. So the ids are `openrouter:` and the PROVIDER is the stub:
 * the real validation path runs, offline, and nothing is billed.
 */
const stubProvider: ModelProvider = {
  name: 'stub',
  evaluate: async ({ model }) => {
    if (model === 'openrouter:stub/good') {
      return {
        output: { rationale: 'Steps are present.', reasons: [], verdict: true, confidence: 0.9 },
        usage: { input: 10, output: 5 },
        servedBy: 'stub/good-endpoint',
        raw: {},
        availableEndpoints: 4,
      }
    }
    if (model === 'openrouter:stub/unroutable')
      throw new ProviderError('unavailable', 'nothing routes')
    if (model === 'openrouter:stub/essay')
      throw new ProviderError('invalid_output', 'rationale too long')
    throw new Error(`the stub provider was asked for an unexpected model: ${model}`)
  },
}

const judge = (overrides: Partial<NewJudgeInput> = {}): NewJudgeInput => ({
  slug: 'is-missing-repro',
  name: 'Missing repro',
  question: 'Does this issue lack reproduction steps?',
  polarity: 'fails',
  weight: 1,
  required: false,
  model: 'openrouter:stub/good',
  pin: DEFAULT_FAKE_PIN,
  ...overrides,
})

const create = (slug: string, judges: NewJudgeInput[]) =>
  createPanel({
    db,
    clock: createFixedClock(),
    provider: stubProvider,
    orgId: ORG,
    actorId: null,
    requestId: 'a'.repeat(32),
    panel: { slug, name: `Panel ${slug}`, threshold: 0.5 },
    judges,
  })

const panelsNamed = (slug: string) =>
  db.select({ id: schema.panels.id }).from(schema.panels).where(eq(schema.panels.slug, slug))

beforeAll(async () => {
  db = createDatabase({ url: DATABASE_URL, max: 4 })
  await db.insert(schema.orgs).values({ id: ORG, slug: `cp-${ORG}`, name: 'Create panel test' })
})

afterAll(async () => {
  // Deleting the org cascades through every version row, even though the app role cannot
  // DELETE them directly — a referential action runs as the table owner (migration 0005).
  // The audit rows it cannot delete stay behind by design; see `keys.test.ts`.
  await db.delete(schema.orgs).where(eq(schema.orgs.id, ORG))
  await db.close()
})

describe('a panel is created whole', () => {
  test('panel, version, judges, versions, membership — and version 1 is LIVE', async () => {
    const result = await create('whole', [
      judge(),
      judge({ slug: 'is-p0', polarity: 'passes', weight: 2 }),
    ])

    expect(result.ok).toBe(true)
    if (!result.ok) return

    const panel = await db.query.panels.findFirst({ where: eq(schema.panels.id, result.panelId) })
    // Activated in the same transaction, so the new panel serves traffic immediately.
    expect(panel?.currentVersionId).toBe(result.panelVersionId)

    const links = await db
      .select()
      .from(schema.panelVersionJudges)
      .where(eq(schema.panelVersionJudges.panelVersionId, result.panelVersionId))
    // The membership rows are what make `pnv_` pin its judge set; without them a version
    // would fix the threshold while the judges underneath it moved.
    expect(links).toHaveLength(2)
  })

  test('each judge version froze WITH its validation, from a real provider call', async () => {
    const result = await create('frozen', [judge()])
    if (!result.ok) throw new Error('expected a created panel')

    const row = await db.query.judgeVersions.findFirst({
      where: eq(schema.judgeVersions.id, result.judges[0]?.judgeVersionId ?? ''),
    })
    // The measurement, on its own column and never merged into the pin (ADR-0026). A count
    // of 4 rather than 0 proves this came through the provider, not the `fake:` short-circuit.
    expect(row?.modelPinValidation?.available_endpoints).toBe(4)
    expect(row?.modelPinValidation?.served_by).toBe('stub/good-endpoint')
    expect(row?.modelPin).toEqual(DEFAULT_FAKE_PIN)
    expect(row?.type).toBe('llm')
  })

  test('both audit events are written, and the question text is NOT in them', async () => {
    const question = 'Does this issue describe a data-loss scenario in the billing export?'
    const result = await create('audited', [judge({ question })])
    if (!result.ok) throw new Error('expected a created panel')

    const rows = await db
      .select({ action: schema.auditEvents.action, data: schema.auditEvents.data })
      .from(schema.auditEvents)
      .where(
        inArray(schema.auditEvents.subjectId, [
          result.panelVersionId,
          result.judges[0]?.judgeVersionId ?? '',
        ]),
      )
    expect(rows.map((row) => row.action).sort()).toEqual([
      'judge_version.created',
      'panel_version.created',
    ])
    // Unbounded customer prose, in a table with no DELETE that M8 will export. The immutable
    // row holds the question; `subject_id` is how you reach it.
    expect(JSON.stringify(rows)).not.toContain(question)
  })
})

describe('a pin that cannot be satisfied writes NOTHING', () => {
  test('one bad judge among good ones: no panel, no rows, the failure located', async () => {
    const result = await create('one-bad', [
      judge(),
      judge({ slug: 'is-p0', model: 'openrouter:stub/unroutable' }),
    ])

    expect(result.ok).toBe(false)
    if (result.ok || result.kind !== 'unsatisfiable_pins') throw new Error('expected pin failures')
    expect(result.failures).toEqual([
      { index: 1, slug: 'is-p0', reason: expect.stringContaining('no endpoint could serve') },
    ])
    // Validation runs before any transaction opens, so there is nothing to roll back.
    expect(await panelsNamed('one-bad')).toHaveLength(0)
  })

  test('EVERY failing judge is reported, not just the first', async () => {
    const result = await create('two-bad', [
      judge({ model: 'openrouter:stub/unroutable' }),
      judge({ slug: 'is-p0' }),
      judge({ slug: 'is-essay', model: 'openrouter:stub/essay' }),
    ])
    if (result.ok || result.kind !== 'unsatisfiable_pins') throw new Error('expected pin failures')

    // Reporting one at a time would have someone fix it, resubmit, and pay for the good
    // judges' validating calls again before learning about the next.
    expect(result.failures.map((failure) => failure.index)).toEqual([0, 2])
    expect(await panelsNamed('two-bad')).toHaveLength(0)
  })
})

describe('a failure HALFWAY through the transaction writes nothing', () => {
  test('a duplicate judge slug, raised after the panel and version were inserted, rolls back', async () => {
    // The route rejects duplicate judge slugs before they reach the service, so this calls
    // the service directly — it is the only way to make Postgres fail AFTER `panels`,
    // `panel_versions` and the first judge are already written. If the transaction were not
    // real, those three rows would survive.
    const attempt = create('halfway', [judge(), judge()])

    await expect(attempt).rejects.toThrow()
    expect(await panelsNamed('halfway')).toHaveLength(0)
  })

  test('and it is NOT misreported as a taken panel slug', async () => {
    // `judges_panel_slug_key` raises the same SQLSTATE as `panels_org_slug_key`. Mapping on
    // the code alone would send someone to fix the wrong field.
    const attempt = create('misreport', [judge(), judge()])
    await expect(attempt).rejects.toThrow()
  })

  test('a genuinely taken panel slug IS reported as one', async () => {
    const first = await create('taken', [judge()])
    expect(first.ok).toBe(true)

    const second = await create('taken', [judge()])
    expect(second).toEqual({ ok: false, kind: 'slug_taken' })
  })
})

describe('the DATABASE refuses a meaningless judge, not only the request schema', () => {
  /**
   * These go through the repository directly, past zod, because the claim is about the last
   * line of defence. A schema that rejects weight 0 is a convenience; a CHECK that rejects it
   * is the guarantee, and the only one a future write path cannot forget.
   */
  const bareJudge = async () => {
    const panelId = newId('pnl_')
    const judgeId = newId('jud_')
    await insertPanel(db, {
      id: panelId,
      orgId: ORG,
      slug: `bare-${panelId.slice(-6).toLowerCase()}`,
      name: 'Bare',
      createdBy: null,
    })
    await insertJudge(db, { id: judgeId, panelId, slug: 'bare', name: 'Bare', createdBy: null })
    return judgeId
  }

  const sqlStateOf = (error: unknown): string | undefined => {
    for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
      if (typeof candidate === 'object' && candidate !== null && 'code' in candidate) {
        return String((candidate as { code: unknown }).code)
      }
    }
    return undefined
  }

  const version = (judgeId: string, overrides: Record<string, unknown>) =>
    insertJudgeVersion(db, {
      id: newId('jdv_'),
      judgeId,
      version: 1,
      polarity: 'fails',
      weight: 1,
      required: false,
      question: 'q',
      model: FAKE_MODEL,
      modelPin: DEFAULT_FAKE_PIN,
      modelPinValidation: {
        validated_at: new Date(0).toISOString(),
        available_endpoints: 0,
        served_by: FAKE_MODEL,
      },
      createdBy: null,
      ...overrides,
    } as Parameters<typeof insertJudgeVersion>[1])

  test('weight 0 is a CHECK violation (`judge_versions_weight_positive`)', async () => {
    const judgeId = await bareJudge()
    const error = await version(judgeId, { weight: 0 }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    // 23514 is check_violation. Asserting the code, not merely that it threw: a bare "threw"
    // also passes on a typo in the statement, which would leave the guarantee untested.
    expect(sqlStateOf(error)).toBe('23514')
  })

  test('a missing polarity is a NOT NULL violation', async () => {
    const judgeId = await bareJudge()
    const error = await version(judgeId, { polarity: null }).then(
      () => undefined,
      (caught: unknown) => caught,
    )
    // 23502 is not_null_violation. Polarity is two-valued and required (ADR-0034): without
    // it the panel score is uncomputable.
    expect(sqlStateOf(error)).toBe('23502')
  })
})
