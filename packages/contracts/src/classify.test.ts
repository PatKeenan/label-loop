import { describe, expect, test } from 'bun:test'
import {
  CLASSIFY_INPUT_MAX_LENGTH,
  classifierIdParamSchema,
  classifyRequestSchema,
  classifyResponseSchema,
  classifyResultSchema,
} from './classify.ts'
import { newId } from './ids.ts'

const REQUEST_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('classify request', () => {
  test('accepts an input alone, and an input with metadata', () => {
    expect(classifyRequestSchema.parse({ input: 'the build is broken' })).toEqual({
      input: 'the build is broken',
    })
    expect(
      classifyRequestSchema.parse({ input: 'x', metadata: { source: 'jira' } }).metadata,
    ).toEqual({ source: 'jira' })
  })

  test('rejects a missing, empty, or oversized input with a field-level issue', () => {
    for (const body of [{}, { input: '' }, { input: 'x'.repeat(CLASSIFY_INPUT_MAX_LENGTH + 1) }]) {
      const result = classifyRequestSchema.safeParse(body)
      expect(result.success).toBe(false)
      expect(result.error?.issues[0]?.path).toEqual(['input'])
    }
  })

  test('rejects a non-string input and non-string metadata values', () => {
    expect(classifyRequestSchema.safeParse({ input: 42 }).success).toBe(false)
    expect(classifyRequestSchema.safeParse({ input: 'x', metadata: { a: 1 } }).success).toBe(false)
  })
})

describe('classify response', () => {
  const result = { label: 'bug', confidence: 0.92, trace_id: newId('tr_') }

  test('parses the result and the enveloped response', () => {
    expect(classifyResultSchema.parse(result)).toEqual(result)
    expect(classifyResponseSchema.parse({ data: result, request_id: REQUEST_ID })).toEqual({
      data: result,
      request_id: REQUEST_ID,
    })
  })

  test('trace_id lives in data, request_id in the envelope (ADR-0010)', () => {
    expect(Object.keys(classifyResponseSchema.shape)).toEqual(['data', 'request_id'])
    expect(Object.keys(classifyResultSchema.shape)).toContain('trace_id')
  })

  test('trace_id must be a tr_ id, not a cls_ one', () => {
    expect(classifyResultSchema.safeParse({ ...result, trace_id: newId('cls_') }).success).toBe(
      false,
    )
  })

  test('confidence is bounded to 0..1', () => {
    for (const confidence of [-0.1, 1.1]) {
      expect(classifyResultSchema.safeParse({ ...result, confidence }).success).toBe(false)
    }
    for (const confidence of [0, 1, 0.5]) {
      expect(classifyResultSchema.safeParse({ ...result, confidence }).success).toBe(true)
    }
  })
})

describe('classifier id path parameter', () => {
  test('accepts a cls_ id and rejects anything else', () => {
    const classifier_id = newId('cls_')
    expect(classifierIdParamSchema.parse({ classifier_id }).classifier_id).toBe(classifier_id)
    expect(classifierIdParamSchema.safeParse({ classifier_id: newId('clv_') }).success).toBe(false)
    expect(classifierIdParamSchema.safeParse({ classifier_id: 'cls_nope' }).success).toBe(false)
  })
})
