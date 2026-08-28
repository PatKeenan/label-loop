import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { newId } from '@labelloop/contracts'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/bun-sql'
import { appClient } from '../test-support.ts'
import * as schema from './index.ts'

/**
 * What Postgres actually holds in a `jsonb` column — asked in SQL, not through the ORM.
 *
 * This test exists because the ORM cannot answer the question. Drizzle's stock `jsonb()`
 * stringifies on the way to the driver, and Bun's SQL driver serializes objects itself, so
 * the two together stored a JSON *string* in every jsonb column — and then parsed it back
 * on read, handing the application exactly the object it wrote. Every round-trip assertion
 * passed. The bug was only visible from `psql`.
 *
 * So the assertion is `jsonb_typeof`, and the reason it is worth a test rather than a
 * comment: the payloads in these columns exist to be QUERIED later — a raw provider
 * response replayed at M1, taxonomy codes counted at M5, a dataset exported at M6 — and
 * none of that works against an escaped string.
 */

const client = appClient()
const db = drizzle({ client, schema })

const orgId = newId('org_')
const panelId = newId('pnl_')
const panelVersionId = newId('pnv_')
const judgeId = newId('jud_')
const judgeVersionId = newId('jdv_')
const traceId = newId('tr_')

const RAW = { provider: 'fake', model: 'fake:deterministic', usage: { input: 19, output: 47 } }
const REASONS = ['missing-expected-behaviour', 'no-repro-steps']
const CONTEXT = { source: 'github', repo: 'acme/web' }

beforeAll(async () => {
  await client`INSERT INTO orgs (id, slug, name) VALUES (${orgId}, ${orgId}, 'jsonb fixtures')`
  await client`
    INSERT INTO panels (id, org_id, slug, name) VALUES (${panelId}, ${orgId}, 'jsonb', 'JSONB')
  `
  await client`
    INSERT INTO panel_versions (id, panel_id, version, threshold)
    VALUES (${panelVersionId}, ${panelId}, 1, 0.5)
  `
  await client`
    INSERT INTO judges (id, panel_id, slug, name)
    VALUES (${judgeId}, ${panelId}, 'is-jsonb', 'Is jsonb')
  `
  await client`
    INSERT INTO judge_versions (id, judge_id, version, type, polarity, weight, question, model)
    VALUES (${judgeVersionId}, ${judgeId}, 1, 'llm', 'fails', 1, 'A question?', 'fake:deterministic')
  `

  // Written through the QUERY BUILDER, deliberately: raw SQL would bypass the codec that
  // is the thing under test.
  await db.insert(schema.traces).values({
    id: traceId,
    orgId,
    panelId,
    panelVersionId,
    requestId: 'a'.repeat(32),
    artifact: 'an artifact',
    context: CONTEXT,
    passed: false,
    score: 0,
    complete: true,
    threshold: 0.5,
  })
  await db.insert(schema.traceVerdicts).values({
    traceId,
    judgeVersionId,
    status: 'evaluated',
    verdict: true,
    passed: false,
    reasons: REASONS,
    rawResponse: RAW,
    latencyMs: 3,
    attempts: 1,
  })
})

afterAll(async () => {
  await client`DELETE FROM traces WHERE id = ${traceId}`
  await client`DELETE FROM orgs WHERE id = ${orgId}`
  await client.close()
})

describe('jsonb columns hold JSON, not a string containing JSON', () => {
  test.each([
    ['traces.context', 'SELECT jsonb_typeof(context) AS t FROM traces WHERE id = $1', 'object'],
    [
      'trace_verdicts.raw_response',
      'SELECT jsonb_typeof(raw_response) AS t FROM trace_verdicts WHERE trace_id = $1',
      'object',
    ],
    [
      'trace_verdicts.reasons',
      'SELECT jsonb_typeof(reasons) AS t FROM trace_verdicts WHERE trace_id = $1',
      'array',
    ],
  ])('%s is a jsonb %s', async (_column, query, expected) => {
    const [row] = await client.unsafe(query, [traceId])
    expect((row as { t: string }).t).toBe(expected)
  })

  test('the stored payload is addressable by SQL — the point of storing it at all', async () => {
    const [row] = await client`
      SELECT raw_response->>'model' AS model,
             raw_response->'usage'->>'input' AS input_tokens,
             reasons->>0 AS first_reason
      FROM trace_verdicts WHERE trace_id = ${traceId}
    `
    expect(row).toMatchObject({
      model: 'fake:deterministic',
      input_tokens: '19',
      first_reason: 'missing-expected-behaviour',
    })
  })

  test('and it still round-trips through the query builder', async () => {
    const verdict = await db.query.traceVerdicts.findFirst({
      where: eq(schema.traceVerdicts.traceId, traceId),
    })
    expect(verdict?.rawResponse).toEqual(RAW)
    expect(verdict?.reasons).toEqual(REASONS)

    const trace = await db.query.traces.findFirst({ where: eq(schema.traces.id, traceId) })
    expect(trace?.context).toEqual(CONTEXT)
  })
})
