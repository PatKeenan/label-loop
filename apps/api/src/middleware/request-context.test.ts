import { describe, expect, test } from 'bun:test'
import { requestIdSchema } from '@labelloop/contracts'
import { Hono } from 'hono'
import {
  generateRequestId,
  REQUEST_ID_HEADER,
  REQUEST_ID_KEY,
  requestContext,
} from './request-context.ts'

describe('generateRequestId', () => {
  test('produces a W3C trace id the shared contract accepts', () => {
    // The cross-package assertion that matters: the id this middleware mints is the same
    // shape the envelope schema validates, so the API cannot emit an id it would reject.
    for (let i = 0; i < 100; i++) {
      expect(requestIdSchema.safeParse(generateRequestId()).success).toBe(true)
    }
  })

  test('is 32 lowercase hex characters', () => {
    expect(generateRequestId()).toMatch(/^[0-9a-f]{32}$/)
  })

  test('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1_000 }, generateRequestId))
    expect(ids.size).toBe(1_000)
  })
})

describe('requestContext middleware', () => {
  const app = new Hono<{ Variables: { requestId: string } }>()
    .use('*', requestContext())
    .get('/', (c) => c.json({ seen: c.get(REQUEST_ID_KEY) }))

  test('puts the id on the context and echoes it as a response header', async () => {
    const res = await app.request('/')
    const body = (await res.json()) as { seen: string }
    expect(body.seen).toMatch(/^[0-9a-f]{32}$/)
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(body.seen)
  })

  test('mints a fresh id per request', async () => {
    const first = await app.request('/')
    const second = await app.request('/')
    expect(first.headers.get(REQUEST_ID_HEADER)).not.toBe(second.headers.get(REQUEST_ID_HEADER))
  })

  test('ignores a client-supplied id — the caller does not get to choose it', async () => {
    // P6 will source this from the active span. Trusting an inbound header would let a
    // caller collide two executions in the logs on purpose.
    const res = await app.request('/', { headers: { [REQUEST_ID_HEADER]: 'f'.repeat(32) } })
    expect(res.headers.get(REQUEST_ID_HEADER)).not.toBe('f'.repeat(32))
  })
})
