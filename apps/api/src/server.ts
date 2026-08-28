import { createDatabase } from '@labelloop/db'
import { createErrorReporter } from './adapters/sentry-error-reporter.ts'
import { systemClock } from './adapters/system-clock.ts'
import { createApp } from './app.ts'
import { ConfigError, loadConfig } from './config.ts'
import { installSignalHandlers } from './lifecycle.ts'
import { createFakeProvider, createModelGateway } from './llm/index.ts'
import { createRootLogger } from './middleware/logger.ts'

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
const errorReporter = await createErrorReporter(config)
// The APP role's pool — DML only. The API cannot migrate itself even if asked to: the
// credential it holds has no DDL, and its config schema cannot express one that does.
const db = createDatabase({ url: config.DATABASE_URL, max: config.DATABASE_POOL_MAX })
// The only provider M0 has, and it is deterministic and offline — which is what keeps
// zero-secret boot true (ADR-0009). M1 replaces this one line with a real adapter behind
// the same port; nothing downstream of the gateway knows the difference.
const modelGateway = createModelGateway({ provider: createFakeProvider(), clock: systemClock })
const app = createApp({ config, clock: systemClock, errorReporter, db, modelGateway })

const server = Bun.serve({ port: config.PORT, fetch: app.fetch })

installSignalHandlers({ server, errorReporter, logger, db })

logger.info(
  { port: server.port, url: `http://localhost:${server.port}`, pid: process.pid },
  'listening',
)
