import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { loadConfig } from '../config.ts'
import { createRootLogger, httpLogger } from './logger.ts'
import { requestContext } from './request-context.ts'

/**
 * Deliberately low-entropy stand-ins. The first draft used a realistic-looking key —
 * the live prefix followed by sixteen hex characters — and gitleaks failed CI on it as a
 * `generic-api-key`. Correctly: that is exactly the shape of a real leaked key. The test
 * only needs a value it can search the log output for, so it gets one no scanner will
 * mistake for a live credential.
 */
const FAKE_API_KEY = 'llk_live_EXAMPLE_NOT_A_REAL_KEY'
const FAKE_COOKIE = 'session=EXAMPLE_NOT_A_REAL_SESSION'
const PII_BODY = { input: 'my name is Ada Lovelace and my email is ada@example.com' }

/** Capture the NDJSON the logger actually writes, rather than trusting configuration. */
const capture = () => {
  const lines: string[] = []
  const config = loadConfig({ LOG_LEVEL: 'info', APP_VERSION: '1.2.3', GIT_SHA: 'cafe123' })
  const logger = createRootLogger(config, {
    write: (line: string) => {
      lines.push(line)
    },
  })
  const app = new Hono()
    .use('*', requestContext())
    .use('*', httpLogger(logger))
    .post('/echo', (c) => c.json({ ok: true }))
  return {
    app,
    parsed: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    raw: () => lines.join(''),
  }
}

const request = (app: Hono) =>
  app.request('/echo', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${FAKE_API_KEY}`,
      cookie: FAKE_COOKIE,
      'content-type': 'application/json',
    },
    body: JSON.stringify(PII_BODY),
  })

describe('the request log line', () => {
  test('carries request_id, method and path', async () => {
    const c = capture()
    await request(c.app)
    const [line] = c.parsed()
    expect(line?.request_id).toMatch(/^[0-9a-f]{32}$/)
    expect(line?.req).toEqual({ method: 'POST', path: '/echo' })
    expect(line?.res).toEqual({ status: 200 })
    expect(line?.msg).toBe('request completed')
  })

  test('identifies the build that produced it (ADR-0011)', async () => {
    const c = capture()
    await request(c.app)
    expect(c.parsed()[0]).toMatchObject({
      service: 'labelloop-api',
      version: '1.2.3',
      git_sha: 'cafe123',
    })
  })

  test('NEVER contains headers — the Authorization key must not reach log storage', async () => {
    const c = capture()
    await request(c.app)
    expect(c.raw()).not.toContain(FAKE_API_KEY)
    expect(c.raw()).not.toContain(FAKE_COOKIE)
    expect(c.raw()).not.toContain('authorization')
  })

  test('NEVER contains the request body — payloads live in traces, not logs', async () => {
    const c = capture()
    await request(c.app)
    expect(c.raw()).not.toContain('Ada Lovelace')
    expect(c.raw()).not.toContain('ada@example.com')
  })

  test('names the request id once, not twice under two spellings', async () => {
    const c = capture()
    await request(c.app)
    const [line] = c.parsed()
    expect(line).not.toHaveProperty('reqId')
  })

  test('emits each field once — no duplicated keys from the child logger', async () => {
    const c = capture()
    await request(c.app)
    const raw = c.raw()
    for (const key of ['"service"', '"version"', '"git_sha"', '"env"', '"request_id"']) {
      expect(raw.split(key).length - 1, key).toBe(1)
    }
  })

  test('is valid NDJSON on one line — the collector parses it line by line', async () => {
    const c = capture()
    await request(c.app)
    await request(c.app)
    const raw = c.raw()
    expect(raw.trimEnd().split('\n')).toHaveLength(2)
    expect(() =>
      raw
        .trimEnd()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).not.toThrow()
  })
})
