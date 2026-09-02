import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { DEFAULT_FAKE_PIN, type ModelPin, newId } from '@labelloop/contracts'
import { appClient } from '../test-support.ts'

/**
 * The invariants that are properties of the DATA rather than of the code path that happens
 * to write it. Each one is here because application-level validation would not survive the
 * thing it needs to survive: a seed script, a backfill, an import job, a psql session.
 */

const db = appClient()

const CHECK_VIOLATION = '23514'
const NOT_NULL_VIOLATION = '23502'
const UNIQUE_VIOLATION = '23505'

const rejection = async (query: Promise<unknown>): Promise<unknown> => {
  const outcome = await query.then(
    () => ({ threw: false, error: undefined as unknown }),
    (error: unknown) => ({ threw: true, error }),
  )
  if (!outcome.threw) throw new Error('expected the statement to be rejected, but it succeeded')
  return outcome.error
}

const sqlStateOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code: unknown }).code)
    : undefined

const orgId = newId('org_')
const panelId = newId('pnl_')
const judgeId = newId('jud_')

beforeAll(async () => {
  await db`INSERT INTO orgs (id, slug, name) VALUES (${orgId}, ${orgId}, 'Constraint fixtures')`
  await db`
    INSERT INTO panels (id, org_id, slug, name)
    VALUES (${panelId}, ${orgId}, 'fixtures', 'Fixtures')
  `
  await db`
    INSERT INTO judges (id, panel_id, slug, name)
    VALUES (${judgeId}, ${panelId}, 'is-fixture', 'Is fixture')
  `
})

afterAll(async () => {
  // orgs cascades to panels, judges and their versions.
  await db`DELETE FROM orgs WHERE id = ${orgId}`
  await db.close()
})

const insertJudgeVersion = (fields: {
  version: number
  type: 'code' | 'llm'
  polarity: 'passes' | 'fails'
  /** Nullable HERE only so the not-null violation can be provoked on purpose. */
  weight: number | null
  model: string | null
  /**
   * Omitted means the PAIRED value — an `llm` fixture gets the default pin, a `code` one
   * gets null — so every existing case keeps testing what it was written to test. Pass it
   * explicitly only to violate the pairing on purpose.
   */
  modelPin?: ModelPin | null
}) => {
  // Bound as an object. Pre-stringifying would store a jsonb STRING rather than an object,
  // because Bun's SQL driver serializes objects itself (see jsonb-encoding.test.ts).
  const modelPin =
    fields.modelPin === undefined
      ? fields.type === 'llm'
        ? DEFAULT_FAKE_PIN
        : null
      : fields.modelPin
  return db`
    INSERT INTO judge_versions
      (id, judge_id, version, type, polarity, weight, question, model, model_pin)
    VALUES (
      ${newId('jdv_')}, ${judgeId}, ${fields.version}, ${fields.type}::judge_type,
      ${fields.polarity}::judge_polarity, ${fields.weight}, 'Is this a fixture?', ${fields.model},
      ${modelPin}::jsonb
    )
  `
}

describe('a pin is paired with the type, exactly like the model is (ADR-0022)', () => {
  /**
   * The mirror of `judge_versions_model_matches_type`, and mirrored deliberately: a
   * route-conditional rule — pins only for real routes — would have to be re-reasoned at
   * every read, so a `fake:` judge carries a pin that constrains nothing (ADR-0025).
   *
   * Asserted against Postgres rather than trusted, because this is the column ADR-0003
   * freezes forever. A judge written without a pin cannot be fixed later by editing it;
   * the only remedy is a new version, which is precisely the cost the constraint prevents.
   */
  test('a `code` judge with a pin is REJECTED — it calls nothing, so it constrains nothing', async () => {
    const error = await rejection(
      insertJudgeVersion({
        version: 40,
        type: 'code',
        polarity: 'fails',
        weight: 1,
        model: null,
        modelPin: DEFAULT_FAKE_PIN,
      }),
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('an `llm` judge with NO pin is rejected — the capability contract is not optional', async () => {
    const error = await rejection(
      insertJudgeVersion({
        version: 41,
        type: 'llm',
        polarity: 'fails',
        weight: 1,
        model: 'fake:deterministic',
        modelPin: null,
      }),
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('the paired combinations are both accepted', async () => {
    await insertJudgeVersion({
      version: 42,
      type: 'llm',
      polarity: 'fails',
      weight: 1,
      model: 'fake:deterministic',
    })
    await insertJudgeVersion({
      version: 43,
      type: 'code',
      polarity: 'fails',
      weight: 1,
      model: null,
    })
  })
})

describe('polarity is two-valued, and every judge carries a weight', () => {
  /**
   * The single most load-bearing constraint in the schema (ADR-0019, ADR-0034). Every judge
   * scores, so every judge must carry a weight or the panel score is uncomputable — and a
   * weight of zero is a judge that cannot move the number it is configured to move.
   */
  test('a scoring judge with a weight is accepted', async () => {
    await insertJudgeVersion({
      version: 1,
      type: 'llm',
      polarity: 'fails',
      weight: 0.5,
      model: 'frontier:sonnet',
    })
  })

  test('a judge WITHOUT a weight is rejected — by the column, not by a check', async () => {
    // A column-level NOT NULL rather than a CHECK, deliberately (ADR-0035): it is what
    // flows into Drizzle's inferred types, so an unweighted judge is a compile error
    // upstream of ever being a runtime one. `23502` rather than `23514` is that decision
    // showing up in the SQLSTATE.
    const error = await rejection(
      insertJudgeVersion({
        version: 4,
        type: 'llm',
        polarity: 'passes',
        weight: null,
        model: 'frontier:sonnet',
      }),
    )
    expect(sqlStateOf(error)).toBe(NOT_NULL_VIOLATION)
  })

  test('a weight of zero is rejected — a judge that cannot move the score', async () => {
    const error = await rejection(
      insertJudgeVersion({
        version: 5,
        type: 'llm',
        polarity: 'fails',
        weight: 0,
        model: 'frontier:sonnet',
      }),
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('`does_not_score` is not even representable — the value does not come back', async () => {
    /**
     * The permanent regression guard for ADR-0034. `does_not_score` was a real value of
     * this enum until migration 0009 removed it, and the product test that removed it lives
     * in prose: only the type system can keep it from being re-added by someone reading the
     * older comments. Postgres rejects it before any check runs.
     */
    const error = await rejection(
      db`
        INSERT INTO judge_versions (id, judge_id, version, type, polarity, weight, question)
        VALUES (${newId('jdv_')}, ${judgeId}, 6, 'code', 'does_not_score', 0.5, 'q')
      `,
    )
    // 22P02 = invalid_text_representation.
    expect(sqlStateOf(error)).toBe('22P02')
  })

  test('nor is any other value outside the two', async () => {
    const error = await rejection(
      db`
        INSERT INTO judge_versions (id, judge_id, version, type, polarity, weight, question)
        VALUES (${newId('jdv_')}, ${judgeId}, 7, 'code', 'maybe', 0.5, 'q')
      `,
    )
    expect(sqlStateOf(error)).toBe('22P02')
  })
})

describe('a judge type has to agree with whether it names a model', () => {
  test('a code judge naming a model is rejected', async () => {
    const error = await rejection(
      insertJudgeVersion({
        version: 6,
        type: 'code',
        polarity: 'fails',
        weight: 0.5,
        model: 'frontier:sonnet',
      }),
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('an llm judge naming no model is rejected', async () => {
    const error = await rejection(
      insertJudgeVersion({ version: 7, type: 'llm', polarity: 'fails', weight: 0.5, model: null }),
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('a code judge with no model is accepted', async () => {
    await insertJudgeVersion({
      version: 8,
      type: 'code',
      polarity: 'fails',
      weight: 1,
      model: null,
    })
  })
})

describe('ids carry their prefix, enforced by the database', () => {
  test('a panel id with the wrong prefix is rejected', async () => {
    const error = await rejection(
      db`INSERT INTO panels (id, org_id, slug, name) VALUES (${newId('jud_')}, ${orgId}, 'x', 'X')`,
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('an id that is not a ULID at all is rejected', async () => {
    const error = await rejection(
      db`INSERT INTO panels (id, org_id, slug, name) VALUES ('pnl_nope', ${orgId}, 'y', 'Y')`,
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })
})

describe('versions are unique and monotonic per parent', () => {
  test('two judge versions cannot share a version number', async () => {
    const error = await rejection(
      insertJudgeVersion({
        version: 1,
        type: 'llm',
        polarity: 'fails',
        weight: 0.5,
        model: 'frontier:sonnet',
      }),
    )
    expect(sqlStateOf(error)).toBe(UNIQUE_VIOLATION)
  })

  test('version zero is rejected — versions start at 1', async () => {
    const error = await rejection(
      insertJudgeVersion({
        version: 0,
        type: 'llm',
        polarity: 'fails',
        weight: 0.5,
        model: 'frontier:sonnet',
      }),
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })
})

describe('a panel version pins its threshold, and the threshold is a share', () => {
  test('a threshold above 1 is rejected', async () => {
    const error = await rejection(
      db`
        INSERT INTO panel_versions (id, panel_id, version, threshold)
        VALUES (${newId('pnv_')}, ${panelId}, 1, 1.5)
      `,
    )
    expect(sqlStateOf(error)).toBe(CHECK_VIOLATION)
  })

  test('a panel version has no mutable configuration column to update', async () => {
    /**
     * Immutability at M0 is structural rather than granted: there is nothing on the row to
     * change. Every column here is written once at insert — `created_by` included, since
     * authorship is a historical fact rather than a setting. If a future migration adds a
     * genuinely mutable column, this test is what should make someone stop and decide
     * deliberately rather than discover it later.
     */
    const rows = (await db`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'panel_versions' ORDER BY column_name
    `) as Array<{ column_name: string }>
    expect(rows.map((row) => row.column_name)).toEqual([
      'aggregation_policy',
      'created_at',
      'created_by',
      'id',
      'panel_id',
      'threshold',
      'version',
    ])
  })
})
