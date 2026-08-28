import { createDatabase } from '@labelloop/db'
import { createErrorReporter } from './adapters/sentry-error-reporter.ts'
import { systemClock } from './adapters/system-clock.ts'
import { createApp } from './app.ts'
import { createAuth } from './auth.ts'
import { ConfigError, loadConfig } from './config.ts'
import { createPgBossQueue, registerJobHandlers } from './jobs/index.ts'
import { installSignalHandlers } from './lifecycle.ts'
import { createFakeProvider, createModelGateway } from './llm/index.ts'
import { createRootLogger } from './middleware/logger.ts'
import { startTelemetry } from './otel.ts'

/**
 * The entrypoint, and the only file that touches the real world: it reads the real
 * environment, picks the real adapters, and opens the real socket. Everything below it
 * receives its dependencies.
 */

const config = (() => {
  try {
    return loadConfig()
  } catch (error) {
    if (error instanceof ConfigError) {
      // Before config is parsed there is no logger and no log level to honour, so this
      // is the one place a bare write to stderr is correct.
      process.stderr.write(`${error.message}\n`)
      process.exit(1)
    }
    throw error
  }
})()

const logger = createRootLogger(config)

// Telemetry FIRST, before anything that might want to trace and — more importantly —
// before the Sentry SDK loads. Sentry's own OpenTelemetry setup is disabled
// (`initWithoutDefaultIntegrations`, ADR-0007), and the order here makes that belt-and-
// braces rather than load-bearing: our provider is already the global one by the time the
// second SDK exists. Verified rather than assumed — see `otel.test.ts`.
const telemetry = startTelemetry(config, logger)
logger.info(
  {
    exporting: telemetry.exporting,
    endpoint: config.OTEL_EXPORTER_OTLP_ENDPOINT ?? null,
  },
  telemetry.exporting
    ? 'tracing enabled, exporting spans'
    : 'tracing enabled, spans are NOT exported (OTEL_EXPORTER_OTLP_ENDPOINT is unset)',
)

const errorReporter = await createErrorReporter(config)
// The APP role's pool — DML only. The API cannot migrate itself even if asked to: the
// credential it holds has no DDL, and its config schema cannot express one that does.
const db = createDatabase({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX })
// The only provider M0 has, and it is deterministic and offline — which is what keeps
// zero-secret boot true (ADR-0009). M1 replaces this one line with a real adapter behind
// the same port; nothing downstream of the gateway knows the difference.
const modelGateway = createModelGateway({
  provider: createFakeProvider(),
  clock: systemClock,
  tracer: telemetry.tracer,
})

// The queue's own pool, on the app role's credential — which cannot install the schema it
// connects to. `bun run db:migrate` did that as the migrator, and `start()` below REFUSES
// if it did not: a boot that fails saying "run the migrations" is better than a process
// that serves traffic whose follow-up work has nowhere to go.
//
// A failure here is deliberately fatal rather than degraded. The container restarts, which
// is the recovery when the cause is a Postgres that is not up yet, and compose gates on
// `/readyz` so nothing reaches a replica that never got this far.
const jobs = createPgBossQueue({
  url: config.DATABASE_URL,
  poolMax: config.QUEUE_POOL_MAX,
  // pg-boss reports maintenance and polling failures on an event emitter, so without this
  // they would be silent. Reporting is not handling (ADR-0007) — supervision retries on its
  // own timer, and this is how we find out it has been failing.
  onError: (error) => {
    logger.error({ err: error }, 'queue error')
    errorReporter.report(error, { context: { component: 'queue' } })
  },
})
await jobs.start()
await registerJobHandlers(jobs, { db, clock: systemClock, errorReporter, logger })

// Configured at P3, mounted here at P7 (plan D-E). It takes the APP role's handle like
// everything else: better-auth reads and writes its four tables and, with
// `disableMigrations`, cannot reach for DDL it does not have the privilege to issue.
const auth = createAuth(db, config)

const app = createApp({
  config,
  clock: systemClock,
  errorReporter,
  db,
  modelGateway,
  jobs,
  tracer: telemetry.tracer,
  auth,
})

const server = Bun.serve({ port: config.PORT, fetch: app.fetch })

installSignalHandlers({ server, errorReporter, logger, db, jobs, telemetry })

logger.info(
  { port: server.port, url: `http://localhost:${server.port}`, pid: process.pid },
  'listening',
)
