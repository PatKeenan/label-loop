import { describe, expect, test } from 'bun:test'
import { z } from '@hono/zod-openapi'
import { errorEnvelopeSchema, requestIdSchema, successEnvelope } from './envelope.ts'

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('envelope', () => {
  test('parses a success fixture', () => {
    const schema = successEnvelope(z.object({ label: z.string() }))
    expect(schema.parse({ data: { label: 'bug' }, request_id: REQUEST_ID })).toEqual({
      data: { label: 'bug' },
      request_id: REQUEST_ID,
    })
  })

  test('parses a failure fixture, with and without field issues', () => {
    expect(
      errorEnvelopeSchema.parse({
        error: { code: 'INTERNAL', message: 'Something went wrong.' },
        request_id: REQUEST_ID,
      }).error.issues,
    ).toBeUndefined()

    const validation = errorEnvelopeSchema.parse({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request body failed validation.',
        issues: [{ path: 'input', message: 'Required' }],
      },
      request_id: REQUEST_ID,
    })
    expect(validation.error.issues).toEqual([{ path: 'input', message: 'Required' }])
  })

  test('request_id is required on BOTH shapes — the failure path is the point', () => {
    expect(
      errorEnvelopeSchema.safeParse({ error: { code: 'INTERNAL', message: 'x' } }).success,
    ).toBe(false)
    const schema = successEnvelope(z.string())
    expect(schema.safeParse({ data: 'x' }).success).toBe(false)
  })

  test('the envelope carries request_id and never trace_id (ADR-0010)', () => {
    const shape = Object.keys(errorEnvelopeSchema.shape)
    expect(shape).toContain('request_id')
    expect(shape).not.toContain('trace_id')
  })

  test('an unknown error code is rejected — the taxonomy is closed', () => {
    const result = errorEnvelopeSchema.safeParse({
      error: { code: 'TEAPOT', message: 'x' },
      request_id: REQUEST_ID,
    })
    expect(result.success).toBe(false)
  })

  test('request_id must be a 32-character lowercase hex W3C trace id', () => {
    expect(requestIdSchema.parse(REQUEST_ID)).toBe(REQUEST_ID)
    for (const bad of [
      REQUEST_ID.toUpperCase(),
      REQUEST_ID.slice(0, 31),
      `${REQUEST_ID}f`,
      '0'.repeat(32),
      'not-a-trace-id',
      '',
    ]) {
      expect(requestIdSchema.safeParse(bad).success, bad).toBe(false)
    }
  })
})
