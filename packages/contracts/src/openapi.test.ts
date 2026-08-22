import { describe, expect, test } from 'bun:test'
import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import {
  classifierIdParamSchema,
  classifyRequestSchema,
  classifyResponseSchema,
} from './classify.ts'
import { errorEnvelopeSchema } from './envelope.ts'
import { parseId } from './ids.ts'

/**
 * Proof that the schemas are OpenAPI-describable, done the only way that cannot lie:
 * mount them on a route and generate the document. The route here is a throwaway — the
 * real one lands in `apps/api` at P4 — but the schemas are the shipped ones.
 */
const generate = async () => {
  const app = new OpenAPIHono()
  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/classify/{classifier_id}',
      request: {
        params: classifierIdParamSchema,
        body: { content: { 'application/json': { schema: classifyRequestSchema } } },
      },
      responses: {
        200: {
          description: 'The classification.',
          content: { 'application/json': { schema: classifyResponseSchema } },
        },
        422: {
          description: 'The request body failed validation.',
          content: { 'application/json': { schema: errorEnvelopeSchema } },
        },
      },
    }),
    (c) =>
      c.json(
        {
          data: {
            label: 'bug',
            confidence: 1,
            trace_id: parseId('tr_', 'tr_01ARZ3NDEKTSV4RRFFQ69G5FAV'),
          },
          request_id: '4bf92f3577b34da6a3ce929d0e0e4736',
        },
        200,
      ),
  )
  app.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'LabelLoop', version: '0' } })
  const res = await app.request('/openapi.json')
  return (await res.json()) as unknown
}

describe('OpenAPI describability', () => {
  test('the classify schemas generate a document with their descriptions and examples', async () => {
    const doc = await generate()
    const json = JSON.stringify(doc)
    expect(json).toContain('The text to classify.')
    expect(json).toContain('the build is broken')
    expect(json).toContain('The classification.')
    // The named components survive as component names, not inlined anonymous objects.
    expect(json).toContain('ClassifyRequest')
    expect(json).toContain('ErrorEnvelope')
  })

  test('the path parameter and the error envelope are both described', async () => {
    const json = JSON.stringify(await generate())
    expect(json).toContain('classifier_id')
    expect(json).toContain('The API key must be scoped to it.')
    expect(json).toContain('VALIDATION_ERROR')
  })
})
