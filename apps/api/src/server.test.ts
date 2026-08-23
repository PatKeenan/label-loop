import { describe, expect, test } from 'bun:test'

/**
 * The end-to-end lifecycle test: a real process, a real socket, a real SIGTERM.
 * `lifecycle.test.ts` proves the shutdown *sequence* in isolation; this proves the
 * entrypoint actually wires it up, which is the part a unit test cannot see.
 */
const SERVER = new URL('./server.ts', import.meta.url).pathname

type Started = {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
  /** Always 127.0.0.1 — `localhost` can resolve to ::1 and miss an IPv4-bound socket. */
  base: string
}

/**
 * The log line says the socket is open; this confirms it actually accepts. A bounded
 * retry rather than a fixed sleep, so the suite is neither flaky nor artificially slow.
 */
const waitUntilAccepting = async (proc: Bun.Subprocess, base: string): Promise<void> => {
  const deadline = Date.now() + 5_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/healthz`)
      return
    } catch (error) {
      lastError = error
      await Bun.sleep(25)
    }
  }
  proc.kill('SIGKILL')
  throw new Error(`server never accepted a connection on ${base}: ${String(lastError)}`)
}

/** Boot the server on an ephemeral port and wait for it to say it is listening. */
const start = async (env: Record<string, string> = {}): Promise<Started> => {
  const proc = Bun.spawn(['bun', SERVER], {
    // PORT=0 asks the OS for a free port, so concurrent test runs cannot collide.
    env: { ...process.env, PORT: '0', NODE_ENV: 'test', LOG_LEVEL: 'info', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  const deadline = Date.now() + 15_000

  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    for (const line of buffered.split('\n')) {
      if (!line.trim().startsWith('{')) continue
      const parsed = JSON.parse(line) as { msg?: string; port?: number }
      if (parsed.msg === 'listening' && typeof parsed.port === 'number') {
        reader.releaseLock()
        const base = `http://127.0.0.1:${parsed.port}`
        await waitUntilAccepting(proc, base)
        return { proc, base }
      }
    }
  }
  reader.releaseLock()
  proc.kill('SIGKILL')
  throw new Error('server never reported that it was listening')
}

describe('the server process', () => {
  test('serves /healthz and exits 0 on SIGTERM', async () => {
    // Draining itself is proven deterministically in `lifecycle.test.ts`, against a
    // handler that is genuinely mid-flight when the shutdown starts. What this proves is
    // the part only a real process can: that the entrypoint wires the signal at all.
    const { proc, base } = await start()

    expect((await fetch(`${base}/healthz`)).status).toBe(200)

    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)
  }, 30_000)

  test('stops accepting new connections after SIGTERM', async () => {
    const { proc, base } = await start()
    expect((await fetch(`${base}/healthz`)).status).toBe(200)

    proc.kill('SIGTERM')
    expect(await proc.exited).toBe(0)

    await expect(fetch(`${base}/healthz`)).rejects.toThrow()
  }, 30_000)

  test('refuses to boot on invalid config, naming the field on stderr', async () => {
    const proc = Bun.spawn(['bun', SERVER], {
      env: { ...process.env, PORT: '0', LOG_LEVEL: 'not-a-level' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    expect(code).toBe(1)
    expect(stderr).toContain('LOG_LEVEL')
  }, 30_000)
})
