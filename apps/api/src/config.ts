import { z } from 'zod'

/**
 * All configuration arrives as environment variables (ADR-0009) and is validated here,
 * once, at boot. Invalid or missing config crashes the process naming the field — never
 * a runtime surprise three hours later (CONVENTIONS.md "Config").
 *
 * Every value has a working local default, so a fresh clone boots with zero secrets
 * (ADR-0009). The exceptions are the two build-provenance fields, which are *required in
 * production only*: shipping an image that cannot say which version it is defeats
 * ADR-0011's whole chain from release-please to `/healthz` and `service.version`.
 */

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const

/**
 * What this process calls itself, in both signals it emits: pino's `service` field and
 * OTel's `service.name` resource attribute. One constant so a log line and a span can
 * never disagree about which service they came from — the join between them is a string
 * match in Grafana, and a rename in one place would break it silently.
 */
export const SERVICE_NAME = 'labelloop-api'

/** The placeholders that mark "nobody told us" — legal in dev, a boot failure in production. */
export const DEV_VERSION = '0.0.0-dev'
export const DEV_GIT_SHA = 'unknown'

const configSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** 0 is the standard "ask the OS for a free port" value; tests rely on it. */
    PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
    LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
    /** Injected as a Docker build arg from the release-please version (ADR-0011). */
    APP_VERSION: z.string().min(1).default(DEV_VERSION),
    /** Injected as a Docker build arg from the built commit (ADR-0011). */
    GIT_SHA: z.string().min(1).default(DEV_GIT_SHA),
    /** Unset is a supported state: the reporter becomes a no-op (ADR-0009). */
    SENTRY_DSN: z.url().optional(),
    /**
     * The APP role's connection (CONVENTIONS.md "Data rules") — DML only, never DDL.
     *
     * The first genuinely required variable, and deliberately without a default. A
     * localhost fallback would mean a production deploy that forgot to set this boots
     * successfully and quietly talks to nothing, which is precisely the runtime surprise
     * boot-time validation exists to prevent. `.env.example` carries a working local value.
     *
     * The migrator and superuser connections are absent from this schema on purpose: the
     * API never migrates and never creates roles, so it should not be *able* to express
     * those credentials. They are read by the scripts that need them.
     */
    DATABASE_URL: z
      .url()
      .refine(
        (url) => url.startsWith('postgres://') || url.startsWith('postgresql://'),
        'must be a postgres:// or postgresql:// connection string',
      ),
    /**
     * Where spans go (ADR-0007) — the OTel Collector's OTLP/HTTP base URL, without the
     * `/v1/traces` suffix, which the exporter appends. The standard OTel variable name, so
     * the value is the one an operator already knows how to set.
     *
     * Optional, and unset is a first-class state rather than a degraded one: the tracer
     * provider still runs, so `request_id` is still a real W3C trace id, and the spans are
     * simply not sent anywhere. That is what keeps `bun run dev` against nothing but
     * Postgres a working configuration.
     *
     * No default, for the same reason `DATABASE_URL` has none: a baked-in `localhost`
     * would let a production deploy that forgot this variable boot happily and export its
     * traces into a void, which is indistinguishable from having no traffic.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT: z
      .url()
      .refine(
        (url) => url.startsWith('http://') || url.startsWith('https://'),
        'must be an http:// or https:// OTLP endpoint',
      )
      // A trailing slash would produce `…//v1/traces`, which some collectors 404 on.
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
    /** Bounded on purpose: an unbounded pool turns one slow query into a connection storm. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    /**
     * The queue's own pool, which is a second claim on the same `max_connections`.
     *
     * pg-boss polls on a timer and holds a connection while it fetches, so it gets its own
     * pool rather than competing with the request path for the one above — and a small
     * default, because the number that matters to Postgres is the sum of the two times the
     * number of replicas.
     */
    QUEUE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(2),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return
    const placeholders = [
      ['APP_VERSION', config.APP_VERSION, DEV_VERSION],
      ['GIT_SHA', config.GIT_SHA, DEV_GIT_SHA],
    ] as const
    for (const [field, value, placeholder] of placeholders) {
      if (value !== placeholder) continue
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `must be set in production — it is a container build arg (ADR-0011)`,
      })
    }
  })

export type Config = z.infer<typeof configSchema>

/** Thrown only at boot. Its message names every offending field, one per line. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError'
  readonly fields: readonly string[]

  constructor(message: string, fields: readonly string[]) {
    super(message)
    this.fields = fields
  }
}

const describe = (issue: z.core.$ZodIssue): string => {
  const field = issue.path.length > 0 ? issue.path.join('.') : '(root)'
  return `  - ${field}: ${issue.message}`
}

/**
 * Parse and validate configuration. Takes the environment as a parameter rather than
 * reaching for `process.env`, so tests exercise the real parser against real fixtures.
 */
export const loadConfig = (env: Record<string, string | undefined> = process.env): Config => {
  const result = configSchema.safeParse(env)
  if (result.success) return result.data

  const issues = result.error.issues
  const fields = issues.map((issue) => issue.path.join('.')).filter((field) => field.length > 0)
  throw new ConfigError(
    `Invalid configuration — the process cannot start:\n${issues.map(describe).join('\n')}`,
    fields,
  )
}
