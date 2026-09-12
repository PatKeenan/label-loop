import { z } from 'zod'

/**
 * All configuration arrives as environment variables (ADR-0009) and is validated here,
 * once, at boot. Invalid or missing config crashes the process naming the field — never
 * a runtime surprise three hours later (CONVENTIONS.md "Config").
 *
 * Every value has a working local default, so a fresh clone boots with zero secrets
 * (ADR-0009). Six are *required in production only*, and the `superRefine` at the bottom
 * is where that lives: the two build-provenance fields, because an image that cannot say
 * which version it is defeats ADR-0011's whole chain from release-please to `/healthz`
 * and `service.version`; the session secret, because its default is committed; the
 * provider key, because an API deployed to judge without one cannot judge; and the two
 * GitHub OAuth fields, because credential sign-in is disabled in production (ADR-0049),
 * which makes them the only door into the console rather than a degradation of it.
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

/**
 * The session-signing key better-auth uses when nobody supplied one. Self-describing and
 * zero-entropy on purpose: a realistic-looking literal committed here is indistinguishable
 * from a leaked secret, to a scanner and to a reader (the lesson of P2's gitleaks failure).
 *
 * Its presence is what keeps zero-secret boot true (ADR-0009) while still making a
 * production deploy that forgot the variable fail at boot rather than silently sign every
 * console session with a value published on GitHub.
 */
export const DEV_AUTH_SECRET = 'localdev-not-a-secret'

/**
 * `z.url()` alone is not enough for anything a browser has to reach. `new URL()` accepts
 * any scheme, so `localhost:5173` — the single most likely typo for an origin — parses
 * happily as a URL whose scheme is `localhost`, and its `.origin` is the string `"null"`.
 * A CORS header of `null` matches nothing, so the failure surfaces as a console that
 * cannot log in rather than as a configuration error naming the field.
 */
const isHttpUrl = (url: string): boolean => url.startsWith('http://') || url.startsWith('https://')

const HTTP_URL_MESSAGE = 'must be an http:// or https:// URL'

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
      .refine(isHttpUrl, 'must be an http:// or https:// OTLP endpoint')
      // A trailing slash would produce `…//v1/traces`, which some collectors 404 on.
      .transform((url) => url.replace(/\/+$/, ''))
      .optional(),
    /**
     * The key better-auth signs and encrypts session material with (ADR-0008).
     *
     * Defaulted rather than required, because a fresh clone must boot with no secrets —
     * and rejected in production below, because the default is committed. Note what this
     * variable is NOT: it is not on the `/v1` path. API keys are our own hashed credentials
     * (ADR-0003) and never touch better-auth, so rotating this logs the console out and
     * changes nothing about a customer's integration.
     */
    BETTER_AUTH_SECRET: z.string().min(1).default(DEV_AUTH_SECRET),
    /**
     * The credential for the M1 provider (ADR-0021). Optional, because a fresh clone must
     * boot and seed with no secrets at all: without it the registry holds only the `fake:`
     * adapter, and every seeded judge is a `fake:` judge, so the whole path still runs.
     *
     * REQUIRED in production, by the `superRefine` below and beside the build-provenance
     * guards. An API deployed to judge with no key is not a degraded system, it is a broken
     * one: every `openrouter:` judge on it answers `unavailable` for as long as it runs, and
     * a panel of them returns a `503` per call. Boot is where that should be said, because
     * the alternative is discovering it from a customer's first request.
     */
    OPENROUTER_API_KEY: z.string().min(1).optional(),
    /**
     * The GitHub OAuth app the console signs in with (M4, ADR-0049). Optional locally, so
     * ADR-0009's zero-secret boot survives: without them the GitHub provider is simply not
     * registered and the seeded password account is the way in.
     *
     * REQUIRED in production, and for a sharper reason than the provider key above —
     * credential sign-in is DISABLED there, so these two are the only door. An image
     * deployed without them has no way for anyone to sign in at all, which is a failure
     * worth having at boot rather than at the login screen.
     *
     * Also checked as a PAIR outside production, which the other optional credentials are
     * not: half a pair leaves the provider unregistered and the button missing, with
     * nothing in the logs to say a variable was misspelled.
     */
    GITHUB_CLIENT_ID: z.string().min(1).optional(),
    GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    /**
     * Where a browser reaches THIS api. better-auth builds cookie scope and callback URLs
     * from it, so it is the origin as the browser sees it, not as the process sees itself —
     * behind a proxy those differ, and the one that matters is the browser's.
     */
    API_BASE_URL: z.url().refine(isHttpUrl, HTTP_URL_MESSAGE).default('http://localhost:3000'),
    /**
     * Where the console runs. It is the CORS allow-list and better-auth's trusted origin,
     * both of which need an exact origin, so a value carrying a path or a trailing slash is
     * normalised to one rather than quietly never matching.
     *
     * Two origins rather than one is the dev reality: Vite serves the console on 5173 while
     * the API answers on 3000. They are cross-ORIGIN but same-SITE — cookies ignore ports —
     * so the session cookie rides along on `SameSite=Lax` and only CORS has to be told.
     */
    WEB_ORIGIN: z
      .url()
      .refine(isHttpUrl, HTTP_URL_MESSAGE)
      .transform((url) => new URL(url).origin)
      .default('http://localhost:5173'),
    /**
     * Where the rate limiter's counters live (ADR-0038, M2).
     *
     * Defaulted, unlike `DATABASE_URL`, and the difference is deliberate rather than
     * inconsistent. A production deploy pointed at a Redis that is not there does not
     * silently talk to nothing — it fails open, loudly, per request (ADR-0040), which is
     * the runtime surprise `DATABASE_URL`'s missing default exists to prevent and this one
     * therefore does not need. It is not a secret either, so ADR-0009's zero-secret boot is
     * untouched: the value below is what `infra/docker-compose.yml` starts.
     */
    REDIS_URL: z
      .url()
      .refine(
        (url) => url.startsWith('redis://') || url.startsWith('rediss://'),
        'must be a redis:// or rediss:// connection string',
      )
      .default('redis://localhost:6380'),
    /**
     * How long the FAKE provider takes to answer, in milliseconds. Zero — off — unless a
     * load run asks for it (M2).
     *
     * It exists so `infra/k6/ramp.js` can be pointed at a stack whose judges behave like
     * real ones without a code edit or a provider bill: a ramp against a zero-latency fake
     * measures the throughput of a hash function, which is not a fact about this system.
     * `MEASURED_JUDGE_LATENCY` in `llm/fake-provider.ts` carries the figure and where it
     * came from.
     *
     * It configures the fake and nothing else. A real provider's latency is the real
     * provider's, and no setting here can change it.
     */
    FAKE_PROVIDER_LATENCY_MS: z.coerce.number().int().min(0).max(120_000).default(0),
    /** Half-width of that latency: a call takes mean ± spread, drawn from the call's hash. */
    FAKE_PROVIDER_LATENCY_SPREAD_MS: z.coerce.number().int().min(0).max(120_000).default(0),
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
    const githubFields = [
      ['GITHUB_CLIENT_ID', config.GITHUB_CLIENT_ID],
      ['GITHUB_CLIENT_SECRET', config.GITHUB_CLIENT_SECRET],
    ] as const
    const missingGithub = githubFields.filter(([, value]) => value === undefined)

    if (config.NODE_ENV !== 'production') {
      // GitHub is optional here, but HALF of it is not a supported state anywhere: the
      // provider is registered only when both are present, so one variable set and the
      // other misspelled produces a console with no GitHub button and no error explaining
      // why. Naming the missing half at boot is the whole point of parsing config here.
      if (missingGithub.length === 1) {
        for (const [field] of missingGithub) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message:
              'must be set alongside the other half of the GitHub OAuth pair — the ' +
              'provider is registered only when both are present, so one alone silently ' +
              'disables GitHub sign-in',
          })
        }
      }
      return
    }

    const placeholders = [
      [
        'APP_VERSION',
        config.APP_VERSION,
        DEV_VERSION,
        'must be set in production — it is a container build arg (ADR-0011)',
      ],
      [
        'GIT_SHA',
        config.GIT_SHA,
        DEV_GIT_SHA,
        'must be set in production — it is a container build arg (ADR-0011)',
      ],
      [
        'BETTER_AUTH_SECRET',
        config.BETTER_AUTH_SECRET,
        DEV_AUTH_SECRET,
        'must be set in production — the development default is committed, so every ' +
          'session signed with it is forgeable by anyone who has read the repository',
      ],
    ] as const
    for (const [field, value, placeholder, message] of placeholders) {
      if (value !== placeholder) continue
      ctx.addIssue({ code: 'custom', path: [field], message })
    }
    // Not a placeholder rule but the same shape of one: absent is legal everywhere except
    // the one environment where it makes the product not work. There is no committed
    // default that could stand in for it, so the check is presence rather than identity.
    if (config.OPENROUTER_API_KEY === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['OPENROUTER_API_KEY'],
        message:
          'must be set in production — without it no `openrouter:` judge can be served ' +
          '(ADR-0021), and every panel holding one returns 503 per call',
      })
    }
    // The strongest of the production rules, because it is not about degradation: with
    // `emailAndPassword` disabled in production (ADR-0049), GitHub is the ONLY way in. An
    // image missing these boots a console that nobody — including its operator — can sign
    // into, and the symptom is a login page that looks fine.
    for (const [field] of missingGithub) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message:
          'must be set in production — credential sign-in is disabled there (ADR-0049), ' +
          'so GitHub is the only way to sign in and an image without it locks everyone out',
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
