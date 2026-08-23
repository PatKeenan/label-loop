import { createErrorReporter } from './adapters/sentry-error-reporter.ts'
import { systemClock } from './adapters/system-clock.ts'
import { createApp } from './app.ts'
import { ConfigError, loadConfig } from './config.ts'
import { installSignalHandlers } from './lifecycle.ts'
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
const app = createApp({ config, clock: systemClock, errorReporter })

const server = Bun.serve({ port: config.PORT, fetch: app.fetch })

installSignalHandlers({ server, errorReporter, logger })

logger.info(
  { port: server.port, url: `http://localhost:${server.port}`, pid: process.pid },
  'listening',
)
