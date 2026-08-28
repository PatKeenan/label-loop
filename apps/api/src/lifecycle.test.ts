import { describe, expect, test } from 'bun:test'
import { pino } from 'pino'
import { gracefulShutdown, installSignalHandlers } from './lifecycle.ts'
import type { ErrorReporter } from './ports/error-reporter.ts'

const silentLogger = pino({ level: 'silent' })

const harness = () => {
  const order: string[] = []
  let stopArg: boolean | undefined
  const server = {
    stop: async (closeActiveConnections?: boolean) => {
      stopArg = closeActiveConnections
      // Stand in for a request still finishing when the signal arrived.
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('drained')
    },
  }
  const errorReporter: ErrorReporter = {
    report: () => {},
    flush: async () => {
      order.push('flushed')
    },
  }
  const jobs = {
    stop: async () => {
      // Stand in for a job still running when the signal arrived.
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('jobs drained')
    },
  }
  return { order, server, jobs, errorReporter, logger: silentLogger, stopArg: () => stopArg }
}

describe('gracefulShutdown', () => {
  test('drains requests, THEN jobs, THEN flushes telemetry', async () => {
    /**
     * The order is the whole design. Jobs drain AFTER requests because a request still
     * being served can enqueue one — stopping the queue first would drop work created by
     * the very requests the first step exists to protect. Telemetry flushes after both,
     * because a job that failed while draining is exactly the report you want to keep.
     */
    const h = harness()
    await gracefulShutdown('SIGTERM', h)
    expect(h.order).toEqual(['drained', 'jobs drained', 'flushed'])
  })

  test('a process with no queue still shuts down cleanly', async () => {
    // `jobs` is optional so the tests that are about ordering need no pg-boss, and so a
    // future process that only serves HTTP is not forced to invent one.
    const { jobs: _unused, ...withoutJobs } = harness()
    await gracefulShutdown('SIGTERM', withoutJobs)
    expect(withoutJobs.order).toEqual(['drained', 'flushed'])
  })

  test('asks the server to drain, not to sever connections', async () => {
    // stop(true) would cut off requests mid-flight — the exact bug this guards.
    const h = harness()
    await gracefulShutdown('SIGTERM', h)
    expect(h.stopArg()).toBe(false)
  })
})

describe('installSignalHandlers', () => {
  test('exits 0 on SIGTERM once shutdown completes', async () => {
    const h = harness()
    const codes: number[] = []
    const dispose = installSignalHandlers(h, (code) => codes.push(code))
    process.emit('SIGTERM')
    await Bun.sleep(60)
    dispose()
    expect(h.order).toEqual(['drained', 'jobs drained', 'flushed'])
    expect(codes).toEqual([0])
  })

  test('a second signal during shutdown does not start a second drain', async () => {
    const h = harness()
    const codes: number[] = []
    const dispose = installSignalHandlers(h, (code) => codes.push(code))
    process.emit('SIGTERM')
    process.emit('SIGINT')
    process.emit('SIGTERM')
    await Bun.sleep(60)
    dispose()
    expect(h.order).toEqual(['drained', 'jobs drained', 'flushed'])
    expect(codes).toEqual([0])
  })

  test('exits 1 when shutdown itself fails', async () => {
    const codes: number[] = []
    const dispose = installSignalHandlers(
      {
        server: {
          stop: async () => {
            throw new Error('socket wedged')
          },
        },
        errorReporter: { report: () => {}, flush: async () => {} },
        logger: silentLogger,
      },
      (code) => codes.push(code),
    )
    process.emit('SIGTERM')
    await Bun.sleep(60)
    dispose()
    expect(codes).toEqual([1])
  })

  test('removes its listeners on dispose', () => {
    const before = process.listenerCount('SIGTERM')
    const dispose = installSignalHandlers(harness(), () => {})
    expect(process.listenerCount('SIGTERM')).toBe(before + 1)
    dispose()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

describe('draining against a real Bun server', () => {
  /**
   * The claim `gracefulShutdown` makes is that a request already being handled survives
   * the signal. That is a property of `Bun.Server.stop(false)` plus our ordering, so it
   * is proven here against a real socket rather than a stub — with a handler that is
   * unambiguously mid-flight when shutdown begins.
   */
  test('a request in progress finishes, and a request started after it is refused', async () => {
    let released = false
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/slow') return new Response('fast')
        await Bun.sleep(300)
        released = true
        return new Response('slow-done')
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    const errorReporter: ErrorReporter = { report: () => {}, flush: async () => {} }

    const inFlight = fetch(`${base}/slow`).then((r) => r.text())
    // Long enough that the handler is genuinely running, well short of its 300ms.
    await Bun.sleep(100)
    expect(released).toBe(false)

    const shutdown = gracefulShutdown('SIGTERM', { server, errorReporter, logger: silentLogger })
    const afterSignal = fetch(`${base}/fast`).then(
      () => 'accepted',
      () => 'refused',
    )

    await shutdown
    expect(await inFlight).toBe('slow-done')
    expect(released).toBe(true)
    expect(await afterSignal).toBe('refused')
  }, 15_000)
})
