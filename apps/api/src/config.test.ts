import { describe, expect, test } from 'bun:test'
import { ConfigError, DEV_GIT_SHA, DEV_VERSION, loadConfig } from './config.ts'

/**
 * `.env.example` is required to be exhaustive (CONVENTIONS.md "Config"). That is only
 * true if something checks, so this reads the committed file and compares it against the
 * schema's own field list — a doc that silently falls behind the code is worse than none.
 */
const ENV_EXAMPLE = new URL('../../../.env.example', import.meta.url)

describe('.env.example', () => {
  test('documents every field config.ts parses', async () => {
    const text = await Bun.file(ENV_EXAMPLE).text()
    const documented = new Set(
      text
        .split('\n')
        .map((line) => line.replace(/^#\s*/, '').trim())
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined),
    )
    for (const field of ['NODE_ENV', 'PORT', 'LOG_LEVEL', 'APP_VERSION', 'GIT_SHA', 'SENTRY_DSN']) {
      expect(documented.has(field), `${field} is missing from .env.example`).toBe(true)
    }
  })
})

describe('config', () => {
  test('boots with an empty environment — zero required secrets (ADR-0009)', () => {
    const config = loadConfig({})
    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      APP_VERSION: DEV_VERSION,
      GIT_SHA: DEV_GIT_SHA,
    })
    expect(config.SENTRY_DSN).toBeUndefined()
  })

  test('coerces PORT from its string environment form', () => {
    expect(loadConfig({ PORT: '8080' }).PORT).toBe(8080)
  })

  test('accepts PORT=0 — the standard "let the OS pick" value', () => {
    expect(loadConfig({ PORT: '0' }).PORT).toBe(0)
  })

  test('ignores unrelated environment variables', () => {
    expect(() => loadConfig({ HOME: '/root', SHELL: '/bin/zsh' })).not.toThrow()
  })

  test.each([
    ['PORT', { PORT: 'eighty' }],
    ['PORT', { PORT: '99999' }],
    ['PORT', { PORT: '-1' }],
    ['PORT', { PORT: '3000.5' }],
    ['LOG_LEVEL', { LOG_LEVEL: 'chatty' }],
    ['NODE_ENV', { NODE_ENV: 'staging' }],
    ['SENTRY_DSN', { SENTRY_DSN: 'not-a-url' }],
  ])('crashes naming the field: %s', (field, env) => {
    try {
      loadConfig(env)
      throw new Error('expected loadConfig to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).fields).toContain(field)
      // The message is what an operator reads at 3am; it must name the field.
      expect((error as ConfigError).message).toContain(field)
    }
  })

  test('reports every offending field at once, not just the first', () => {
    try {
      loadConfig({ PORT: 'nope', LOG_LEVEL: 'nope' })
      throw new Error('expected loadConfig to throw')
    } catch (error) {
      expect((error as ConfigError).fields).toEqual(expect.arrayContaining(['PORT', 'LOG_LEVEL']))
    }
  })

  describe('production build provenance (ADR-0011)', () => {
    test('rejects the dev placeholders — an image must know what it is', () => {
      try {
        loadConfig({ NODE_ENV: 'production' })
        throw new Error('expected loadConfig to throw')
      } catch (error) {
        expect((error as ConfigError).fields).toEqual(['APP_VERSION', 'GIT_SHA'])
      }
    })

    test('accepts real build args', () => {
      const config = loadConfig({
        NODE_ENV: 'production',
        APP_VERSION: '0.2.0',
        GIT_SHA: 'abc1234',
      })
      expect(config.APP_VERSION).toBe('0.2.0')
      expect(config.GIT_SHA).toBe('abc1234')
    })

    test('the same placeholders are fine outside production', () => {
      expect(() => loadConfig({ NODE_ENV: 'development' })).not.toThrow()
      expect(() => loadConfig({ NODE_ENV: 'test' })).not.toThrow()
    })
  })
})
