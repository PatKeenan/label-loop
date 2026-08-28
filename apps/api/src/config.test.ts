import { describe, expect, test } from 'bun:test'
import { ConfigError, DEV_AUTH_SECRET, DEV_GIT_SHA, DEV_VERSION, loadConfig } from './config.ts'

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
    for (const field of [
      'NODE_ENV',
      'PORT',
      'LOG_LEVEL',
      'APP_VERSION',
      'GIT_SHA',
      'SENTRY_DSN',
      'DATABASE_URL',
      'DATABASE_POOL_MAX',
      // Added at P5 and P6. The list is hand-maintained, which is its weakness — it is a
      // reminder, not a proof — so a new field goes here in the same commit that adds it.
      'QUEUE_POOL_MAX',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      // P7.
      'BETTER_AUTH_SECRET',
      'API_BASE_URL',
      'WEB_ORIGIN',
    ]) {
      expect(documented.has(field), `${field} is missing from .env.example`).toBe(true)
    }
  })
})

/** The one value with no default, so every other test needs it present. */
const DATABASE_URL = 'postgres://labelloop_app:localdev@localhost:5433/labelloop'

describe('config', () => {
  /**
   * P3 is where "boots with an empty environment" stops being true, and the distinction it
   * collapses is worth keeping: zero required SECRETS (ADR-0009) is not zero required
   * configuration. A connection string is not a secret — compose supplies it, `.env.example`
   * carries a working local one — but it must be stated, because the alternative is a
   * localhost default that lets a misconfigured production deploy boot and talk to nothing.
   */
  test('DATABASE_URL is required, and its absence names the field', () => {
    expect(() => loadConfig({})).toThrow(ConfigError)
    const error = (() => {
      try {
        loadConfig({})
        return undefined
      } catch (caught) {
        return caught as ConfigError
      }
    })()
    expect(error?.fields).toEqual(['DATABASE_URL'])
    expect(error?.message).toContain('DATABASE_URL')
  })

  test('a connection string that is not Postgres is rejected by name', () => {
    const error = (() => {
      try {
        loadConfig({ DATABASE_URL: 'https://example.com/db' })
        return undefined
      } catch (caught) {
        return caught as ConfigError
      }
    })()
    expect(error?.fields).toEqual(['DATABASE_URL'])
  })

  test('everything else still defaults — no other secret is required (ADR-0009)', () => {
    const config = loadConfig({ DATABASE_URL })
    expect(config).toEqual({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      APP_VERSION: DEV_VERSION,
      GIT_SHA: DEV_GIT_SHA,
      DATABASE_URL,
      DATABASE_POOL_MAX: 10,
      QUEUE_POOL_MAX: 2,
      BETTER_AUTH_SECRET: DEV_AUTH_SECRET,
      API_BASE_URL: 'http://localhost:3000',
      WEB_ORIGIN: 'http://localhost:5173',
    })
    expect(config.SENTRY_DSN).toBeUndefined()
  })

  test('coerces PORT from its string environment form', () => {
    expect(loadConfig({ DATABASE_URL, PORT: '8080' }).PORT).toBe(8080)
  })

  test('accepts PORT=0 — the standard "let the OS pick" value', () => {
    expect(loadConfig({ DATABASE_URL, PORT: '0' }).PORT).toBe(0)
  })

  test('ignores unrelated environment variables', () => {
    expect(() => loadConfig({ DATABASE_URL, HOME: '/root', SHELL: '/bin/zsh' })).not.toThrow()
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
      loadConfig({ DATABASE_URL, ...env })
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
      loadConfig({ DATABASE_URL, PORT: 'nope', LOG_LEVEL: 'nope' })
      throw new Error('expected loadConfig to throw')
    } catch (error) {
      expect((error as ConfigError).fields).toEqual(expect.arrayContaining(['PORT', 'LOG_LEVEL']))
    }
  })

  describe('production build provenance (ADR-0011)', () => {
    test('rejects the dev placeholders — an image must know what it is', () => {
      try {
        loadConfig({ DATABASE_URL, NODE_ENV: 'production' })
        throw new Error('expected loadConfig to throw')
      } catch (error) {
        expect((error as ConfigError).fields).toEqual([
          'APP_VERSION',
          'GIT_SHA',
          // P7 joins the same list, for a reason that is not provenance but is the same
          // shape: a committed default is fine locally and forgeable in production.
          'BETTER_AUTH_SECRET',
        ])
      }
    })

    test('accepts real build args', () => {
      const config = loadConfig({
        DATABASE_URL,
        NODE_ENV: 'production',
        APP_VERSION: '0.2.0',
        GIT_SHA: 'abc1234',
        BETTER_AUTH_SECRET: 'a-real-secret-from-the-environment',
      })
      expect(config.APP_VERSION).toBe('0.2.0')
      expect(config.GIT_SHA).toBe('abc1234')
    })

    test('the same placeholders are fine outside production', () => {
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'development' })).not.toThrow()
      expect(() => loadConfig({ DATABASE_URL, NODE_ENV: 'test' })).not.toThrow()
    })
  })

  /**
   * The console's own configuration (ADR-0008). All three have working local defaults, so
   * `bun install && bun run dev` still needs no secret — the production guard above is what
   * keeps that from becoming a production hole.
   */
  describe('the console surface (P7)', () => {
    test('the session secret defaults, so a fresh clone boots with none (ADR-0009)', () => {
      expect(loadConfig({ DATABASE_URL }).BETTER_AUTH_SECRET).toBe(DEV_AUTH_SECRET)
    })

    test('WEB_ORIGIN is normalised to an origin — CORS matches exactly, or not at all', () => {
      // A path or a trailing slash here is the classic silent CORS failure: the header is
      // compared byte for byte against the browser's `Origin`, which never carries either.
      expect(loadConfig({ DATABASE_URL, WEB_ORIGIN: 'http://localhost:5173/' }).WEB_ORIGIN).toBe(
        'http://localhost:5173',
      )
      expect(
        loadConfig({ DATABASE_URL, WEB_ORIGIN: 'https://console.example.com/app' }).WEB_ORIGIN,
      ).toBe('https://console.example.com')
    })

    test('a non-URL origin fails at boot, naming the field', () => {
      try {
        loadConfig({ DATABASE_URL, WEB_ORIGIN: 'localhost:5173' })
        throw new Error('expected loadConfig to throw')
      } catch (error) {
        expect((error as ConfigError).fields).toEqual(['WEB_ORIGIN'])
      }
    })
  })
})

describe('OTEL_EXPORTER_OTLP_ENDPOINT (ADR-0007)', () => {
  test('is optional — unset means spans are recorded and not exported', () => {
    const config = loadConfig({ DATABASE_URL })
    // Unset is a supported state, not a degraded one: the tracer still runs, so
    // `request_id` is still a real trace id (ADR-0010) with or without a collector.
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined()
  })

  test('strips a trailing slash, because the exporter appends /v1/traces', () => {
    const config = loadConfig({
      DATABASE_URL,
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/',
    })
    expect(config.OTEL_EXPORTER_OTLP_ENDPOINT).toBe('http://otel-collector:4318')
  })

  test('rejects a non-HTTP endpoint by name', () => {
    // The gRPC port is the easy mistake — 4317 with an `otlp://` or bare host — and the
    // exporter this codebase uses speaks OTLP over HTTP.
    const error = (() => {
      try {
        loadConfig({ DATABASE_URL, OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://otel-collector:4317' })
        return undefined
      } catch (caught) {
        return caught as ConfigError
      }
    })()
    expect(error?.fields).toEqual(['OTEL_EXPORTER_OTLP_ENDPOINT'])
    expect(error?.message).toContain('http://')
  })
})
