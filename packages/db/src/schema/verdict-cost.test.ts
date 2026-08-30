import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { drizzle } from 'drizzle-orm/bun-sql'
import { appClient } from '../test-support.ts'
import * as schema from './index.ts'

/**
 * What Postgres actually holds in `cost_usd` — asked in SQL, because the question is about
 * the column type and an ORM round-trip cannot answer it.
 *
 * ADR-0027 chose `numeric` over `real` on the grounds that this is money and M2's metering
 * sums it. That is a claim about precision, and precision claims are exactly the kind that
 * pass an equality check while being false: a `real` column would return something that
 * prints plausibly and is wrong in the eighth decimal place, which is where a judge call's
 * cost actually lives — one measured $0.0004189581 on 2026-08-30.
 */

const client = appClient()
const db = drizzle({ client, schema })

const orgId = newId('org_')
const panelId = newId('pnl_')
const panelVersionId = newId('pnv_')
const judgeId = newId('jud_')
const judgeVersionId = newId('jdv_')

/** A real measured figure, at the full scale the column declares. */
const REAL_COST = '0.0004189581'

const traceFor = async (id: string) => {
  await db.insert(schema.traces).values({
    id,
    orgId,
    panelId,
    panelVersionId,
    requestId: 'b'.repeat(32),
    artifact: 'an artifact',
    passed: false,
    score: 0,
    complete: true,
    threshold: 0.5,
  })
}

beforeAll(async () => {
  await client`INSERT INTO orgs (id, slug, name) VALUES (${orgId}, ${orgId}, 'cost fixtures')`
  await client`
    INSERT INTO panels (id, org_id, slug, name) VALUES (${panelId}, ${orgId}, 'cost', 'Cost')
  `
  await client`
    INSERT INTO panel_versions (id, panel_id, version, threshold)
    VALUES (${panelVersionId}, ${panelId}, 1, 0.5)
  `
  await client`
    INSERT INTO judges (id, panel_id, slug, name)
    VALUES (${judgeId}, ${panelId}, 'is-costly', 'Is costly')
  `
  await client`
    INSERT INTO judge_versions
      (id, judge_id, version, type, polarity, weight, question, model, model_pin)
    VALUES (
      ${judgeVersionId}, ${judgeId}, 1, 'llm', 'fails', 1, 'A question?', 'fake:deterministic',
      -- The CHECK pairs a pin with an llm type, so a fixture without one is now invalid.
      '{"capabilities":["structured_outputs"],"data_collection":"deny","reasoning":{"effort":"none"}}'::jsonb
    )
  `
})

afterAll(async () => {
  await client`DELETE FROM orgs WHERE id = ${orgId}`
  await client.close()
})

describe('cost_usd is numeric, and that is load-bearing', () => {
  test('reads back as the EXACT decimal that was written', async () => {
    const traceId = newId('tr_')
    await traceFor(traceId)
    await db.insert(schema.traceVerdicts).values({
      traceId,
      judgeVersionId,
      status: 'evaluated',
      verdict: true,
      passed: false,
      inputTokens: 1730,
      outputTokens: 319,
      reasoningTokens: 203,
      costUsd: REAL_COST,
      costPriced: true,
      latencyMs: 2634,
      attempts: 1,
    })

    const [row] = await client`
      SELECT cost_usd::text AS cost, input_tokens, output_tokens, reasoning_tokens, cost_priced
      FROM trace_verdicts WHERE trace_id = ${traceId}
    `
    // `::text` so this is Postgres's own rendering, not the driver's idea of a number.
    expect(row.cost).toBe(REAL_COST)
    expect(row.input_tokens).toBe(1730)
    expect(row.output_tokens).toBe(319)
    expect(row.reasoning_tokens).toBe(203)
    expect(row.cost_priced).toBe(true)
  })

  test('the column is numeric, not a float type — asked of the catalog directly', async () => {
    const [column] = await client`
      SELECT data_type, numeric_precision, numeric_scale
      FROM information_schema.columns
      WHERE table_name = 'trace_verdicts' AND column_name = 'cost_usd'
    `
    expect(column.data_type).toBe('numeric')
    expect(column.numeric_precision).toBe(16)
    expect(column.numeric_scale).toBe(10)
  })

  test('sums exactly across many rows — which is what M2 will actually do to it', async () => {
    const traceId = newId('tr_')
    await traceFor(traceId)
    await db.insert(schema.traceVerdicts).values({
      traceId,
      judgeVersionId,
      status: 'evaluated',
      costUsd: '0.0000000001',
      costPriced: true,
      latencyMs: 1,
      attempts: 1,
    })

    // Three thousand of the smallest representable cost. In float4 this drifts; the whole
    // reason the column is numeric is that an invoice must not.
    const [summed] = await client`
      SELECT (SUM(cost_usd) * 3000)::text AS total
      FROM trace_verdicts WHERE trace_id = ${traceId}
    `
    // Exact, and at the column's declared scale of 10 — no drift, no trailing float noise.
    expect(summed.total).toBe('0.0000003000')
  })
})

describe('a verdict that never ran has no bill', () => {
  test('tokens and cost are null, and cost_priced is false', async () => {
    const traceId = newId('tr_')
    await traceFor(traceId)
    await db.insert(schema.traceVerdicts).values({
      traceId,
      judgeVersionId,
      status: 'error',
      latencyMs: 12,
      attempts: 3,
    })

    const [row] = await client`
      SELECT input_tokens, output_tokens, reasoning_tokens, cost_usd, cost_priced
      FROM trace_verdicts WHERE trace_id = ${traceId}
    `
    // Null rather than zero, deliberately. A zero here would be summed by metering as a
    // free call rather than as no call, and the two are different facts.
    expect(row.input_tokens).toBeNull()
    expect(row.output_tokens).toBeNull()
    expect(row.reasoning_tokens).toBeNull()
    expect(row.cost_usd).toBeNull()
    // NOT NULL with a false default: the absence of a claim is itself the honest default.
    expect(row.cost_priced).toBe(false)
  })

  test('an evaluated verdict may still report no reasoning — absent is not zero', async () => {
    const traceId = newId('tr_')
    await traceFor(traceId)
    await db.insert(schema.traceVerdicts).values({
      traceId,
      judgeVersionId,
      status: 'evaluated',
      inputTokens: 2717,
      outputTokens: 181,
      costUsd: '0.0072440000',
      costPriced: true,
      latencyMs: 5304,
      attempts: 1,
    })

    const [row] = await client`
      SELECT reasoning_tokens, cost_usd::text AS cost FROM trace_verdicts
      WHERE trace_id = ${traceId}
    `
    // The provider said nothing about deliberation, which is not the same as saying none.
    expect(row.reasoning_tokens).toBeNull()
    expect(row.cost).toBe('0.0072440000')
  })
})
