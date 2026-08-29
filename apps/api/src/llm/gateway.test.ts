import { describe, expect, test } from 'bun:test'
import { trace } from '@opentelemetry/api'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { createFakeProvider, FAKE_MODEL, FAKE_SENTINELS } from './fake-provider.ts'
import { createModelGateway, type ModelGatewayOptions } from './index.ts'
import { type ModelProvider, ProviderError, type ProviderFailureKind } from './provider.port.ts'

/**
 * The gateway is where a provider's bad day becomes a member of the closed taxonomy. These
 * tests are mostly about that translation, because it is the boundary a customer sees:
 * everything downstream branches on the code, and nothing downstream ever sees the
 * provider's own error.
 */

const CALL = {
  model: FAKE_MODEL,
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17.',
}

const DOWN = { ...CALL, artifact: `${FAKE_SENTINELS.unavailable} down` }

type GatewayOverrides = Partial<Omit<ModelGatewayOptions, 'provider' | 'clock'>>

/**
 * OTel's global tracer with no provider registered — real object, no-op spans. These tests
 * are about the taxonomy translation, not the telemetry; `spans.test.ts` beside this file
 * asserts on the spans against a provider it owns.
 */
const noopTracer = trace.getTracer('test')

/** The provider is passed in rather than returned, so a test can keep its own handle on it. */
const gatewayFor = (provider: ModelProvider, overrides: GatewayOverrides = {}) => {
  const clock = createFixedClock()
  const gateway = createModelGateway({
    provider,
    clock,
    tracer: noopTracer,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 800, timeoutMs: 50 },
    breakerPolicy: { failureThreshold: 3, openMs: 1_000 },
    random: () => 1,
    ...overrides,
  })
  return { gateway, clock }
}

/**
 * A provider that only ever fails, one way, and counts how many times it was asked. The
 * fake's sentinels do not cover `misconfigured` on purpose: a rejected credential is a
 * property of a real provider, and driving it from an artifact string would put a failure
 * that is OURS behind a knob the caller turns.
 */
const alwaysFailing = (kind: ProviderFailureKind, raw?: unknown) => {
  let calls = 0
  const provider: ModelProvider = {
    name: 'unhappy',
    evaluate: () => {
      calls += 1
      return Promise.reject(
        new ProviderError(kind, 'no credentials found for this request', {
          ...(raw === undefined ? {} : { raw }),
        }),
      )
    },
  }
  return { provider, calls: () => calls }
}

/** Collects log lines so the "provider calls log tokens, cost and latency" rule is testable. */
const recordingLogger = () => {
  const lines: Array<{ level: string; fields: Record<string, unknown>; msg: string }> = []
  const at = (level: string) => (fields: object, msg: string) =>
    lines.push({ level, fields: fields as Record<string, unknown>, msg })
  return { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), lines }
}

describe('a judge that answers', () => {
  test('comes back evaluated, with the tokens, cost and attempt count attached', async () => {
    const { gateway } = gatewayFor(createFakeProvider())
    const outcome = await gateway.judge(CALL)

    expect(outcome.status).toBe('evaluated')
    if (outcome.status !== 'evaluated') throw new Error('unreachable')
    expect(typeof outcome.output.verdict).toBe('boolean')
    expect(outcome.cost.totalTokens).toBeGreaterThan(0)
    expect(outcome.cost.priced).toBe(true)
    expect(outcome.servedBy).toBe(FAKE_MODEL)
    expect(outcome.raw).toBeDefined()
    expect(outcome.attempts).toBe(1)
  })

  test('logs the model, tokens, cost and latency — the metering line, per call', async () => {
    const logger = recordingLogger()
    const { gateway } = gatewayFor(createFakeProvider())
    await gateway.judge(CALL, { logger })

    const completed = logger.lines.find((line) => line.msg === 'provider call completed')
    expect(completed).toBeDefined()
    expect(completed?.fields).toMatchObject({
      provider: 'fake',
      model: FAKE_MODEL,
      served_by: FAKE_MODEL,
      attempts: 1,
    })
    expect(completed?.fields.tokens_in).toBeNumber()
    expect(completed?.fields.cost_usd).toBeNumber()
    expect(completed?.fields.latency_ms).toBeNumber()
  })

  test('no body is logged: payloads live in the traces table, not in log storage', async () => {
    const logger = recordingLogger()
    const { gateway } = gatewayFor(createFakeProvider())
    await gateway.judge(CALL, { logger })
    expect(JSON.stringify(logger.lines)).not.toContain('Safari')
  })
})

describe('a provider that fails', () => {
  test('a retryable failure is retried, and the survivor is still an answer', async () => {
    const { gateway, clock } = gatewayFor(createFakeProvider({ failFirst: 2 }))
    const outcome = await gateway.judge(CALL)

    expect(outcome.status).toBe('evaluated')
    expect(outcome.attempts).toBe(3)
    expect(clock.sleeps).toEqual([100, 200])
  })

  test('backoff is logged per retry, with the attempt and the delay', async () => {
    const logger = recordingLogger()
    const { gateway } = gatewayFor(createFakeProvider({ failFirst: 1 }))
    await gateway.judge(CALL, { logger })

    const retries = logger.lines.filter((line) =>
      line.msg.startsWith('provider call failed, retry'),
    )
    expect(retries).toHaveLength(1)
    expect(retries[0]?.level).toBe('warn')
    expect(retries[0]?.fields).toMatchObject({ attempt: 1, backoff_ms: 100, kind: 'unavailable' })
  })

  test('exhausted retries become PROVIDER_UNAVAILABLE, not the provider’s own error', async () => {
    const { gateway } = gatewayFor(createFakeProvider())
    const outcome = await gateway.judge(DOWN)

    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') throw new Error('unreachable')
    expect(outcome.code).toBe('PROVIDER_UNAVAILABLE')
    expect(outcome.attempts).toBe(3)
    expect(outcome.message).not.toContain('sentinel')
  })

  test('a call that never answers becomes PROVIDER_TIMEOUT', async () => {
    const { gateway } = gatewayFor(createFakeProvider())
    const outcome = await gateway.judge({ ...CALL, artifact: `${FAKE_SENTINELS.slow} hangs` })

    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') throw new Error('unreachable')
    expect(outcome.code).toBe('PROVIDER_TIMEOUT')
  })

  test('an unusable answer is `failed`, not `error` — and is not retried', async () => {
    const provider = createFakeProvider()
    const { gateway } = gatewayFor(provider)
    const outcome = await gateway.judge({
      ...CALL,
      artifact: `${FAKE_SENTINELS.invalidOutput} garbage`,
    })

    expect(outcome.status).toBe('failed')
    expect(outcome.attempts).toBe(1)
    expect(provider.calls).toBe(1)
  })

  test('an adapter that breaks its own contract is INTERNAL, with the cause kept', async () => {
    const broken: ModelProvider = {
      name: 'broken',
      evaluate: () => Promise.reject(new TypeError('undefined is not a function')),
    }
    const { gateway } = gatewayFor(broken)
    const outcome = await gateway.judge(CALL)

    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') throw new Error('unreachable')
    expect(outcome.code).toBe('INTERNAL')
    expect(outcome.message).not.toContain('undefined is not a function')
    expect((outcome.cause as Error).message).toBe('undefined is not a function')
  })
})

/**
 * The fourth kind (ADR-0024). Everything here is the same assertion from a different
 * angle: a failure that cannot self-heal must not be treated as one that can. Before this
 * kind existed a rejected key bought three retries, a circuit whose half-open probe could
 * never succeed, and a `Retry-After` telling the caller to retry something that cannot
 * succeed.
 */
describe('a provider that will never accept us', () => {
  test('is not retried — the second call is the same answer, paid for twice', async () => {
    const unhappy = alwaysFailing('misconfigured')
    const { gateway } = gatewayFor(unhappy.provider)
    const outcome = await gateway.judge(CALL)

    expect(outcome.attempts).toBe(1)
    expect(unhappy.calls()).toBe(1)
  })

  test('never moves the circuit off closed: there is nothing for a probe to recover', async () => {
    const unhappy = alwaysFailing('misconfigured')
    const { gateway } = gatewayFor(unhappy.provider)
    for (let i = 0; i < 10; i++) await gateway.judge(CALL)

    expect(gateway.breakerState(FAKE_MODEL)).toBe('closed')
    // Ten calls, ten attempts: nothing was ever refused, so nothing was ever suppressed.
    expect(unhappy.calls()).toBe(10)
  })

  test('is INTERNAL with the cause kept, and carries none of the provider’s prose', async () => {
    const unhappy = alwaysFailing('misconfigured', { error: { code: 401 } })
    const { gateway } = gatewayFor(unhappy.provider)
    const outcome = await gateway.judge(CALL)

    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') throw new Error('unreachable')
    expect(outcome.code).toBe('INTERNAL')
    expect(outcome.message).not.toContain('credentials')
    expect(outcome.retryAfterSeconds).toBeUndefined()
    // Set so `evaluate.ts` forwards it to the error reporter. A condition nobody is told
    // about is a condition nobody fixes.
    expect((outcome.cause as ProviderError).kind).toBe('misconfigured')
  })

  test('is logged at `error`, which CONVENTIONS defines as alert-worthy', async () => {
    const logger = recordingLogger()
    const { gateway } = gatewayFor(alwaysFailing('misconfigured').provider)
    await gateway.judge(CALL, { logger })

    const lines = logger.lines.filter((line) => line.fields.kind === 'misconfigured')
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('error')
    expect(lines[0]?.fields).toMatchObject({ model: FAKE_MODEL, attempts: 1 })
    // Not `warn`: this never self-heals and takes every judge down at once, so it is the
    // one provider failure an operator has to be woken for.
    expect(logger.lines.some((line) => line.level === 'warn')).toBe(false)
  })

  test('never writes the provider’s payload to a log line, whatever it contains', async () => {
    // A 400 echoes the request back, and a moderation refusal names the flagged input, so
    // the provider's payload on this path routinely CONTAINS the customer's artifact.
    // `ProviderError.raw` is own-enumerable, which means a line logging `err` serializes
    // it — the one way this rule breaks without anybody deciding to break it.
    const logger = recordingLogger()
    const artifact = 'Login button does nothing on Safari 17.'
    const unhappy = alwaysFailing('misconfigured', {
      error: { code: 400, metadata: { flagged_input: artifact } },
    })
    const { gateway } = gatewayFor(unhappy.provider)
    await gateway.judge({ ...CALL, artifact }, { logger })

    // Metadata, not content (CONVENTIONS.md "Logging"). The detail is not lost: `cause`
    // carries the whole error to the error reporter, which is the sink allowed to hold it.
    expect(JSON.stringify(logger.lines)).not.toContain('Safari')
    expect(JSON.stringify(logger.lines)).not.toContain('flagged_input')
    expect(logger.lines.some((line) => line.msg.startsWith('provider rejected'))).toBe(true)
  })

  test('the OTHER kinds are unmoved by its arrival — unavailable still retries and trips', async () => {
    const unhappy = alwaysFailing('unavailable')
    const { gateway } = gatewayFor(unhappy.provider)
    const outcome = await gateway.judge(CALL)

    expect(outcome.attempts).toBe(3)
    if (outcome.status !== 'error') throw new Error('unreachable')
    expect(outcome.code).toBe('PROVIDER_UNAVAILABLE')
    expect(gateway.breakerState(FAKE_MODEL)).toBe('open')
  })
})

describe('the circuit', () => {
  test('opens once the failures mount, then refuses without calling the provider', async () => {
    const provider = createFakeProvider()
    const { gateway } = gatewayFor(provider)

    await gateway.judge(DOWN)
    expect(gateway.breakerState(FAKE_MODEL)).toBe('open')
    const callsBefore = provider.calls

    const refused = await gateway.judge(DOWN)
    expect(refused.status).toBe('error')
    if (refused.status !== 'error') throw new Error('unreachable')
    expect(refused.code).toBe('CIRCUIT_OPEN')
    expect(refused.retryAfterSeconds).toBeGreaterThan(0)
    // Zero, and that is the point: `attempts` counts calls to the judge, and a refused
    // call reached nobody.
    expect(refused.attempts).toBe(0)
    expect(provider.calls).toBe(callsBefore)
  })

  test('the attempt that trips it short-circuits the REST of its own call', async () => {
    const provider = createFakeProvider()
    // Two failures to open, three attempts allowed: the third has nowhere to go.
    const { gateway } = gatewayFor(provider, {
      breakerPolicy: { failureThreshold: 2, openMs: 1_000 },
    })

    const outcome = await gateway.judge(DOWN)
    expect(outcome.status).toBe('error')
    if (outcome.status !== 'error') throw new Error('unreachable')
    expect(outcome.code).toBe('CIRCUIT_OPEN')
    expect(provider.calls).toBe(2)
  })

  test('recovers on its own: after the cooldown, a probe closes the circuit', async () => {
    const provider = createFakeProvider({ failFirst: 3 })
    const { gateway, clock } = gatewayFor(provider)

    await gateway.judge(CALL)
    expect(gateway.breakerState(FAKE_MODEL)).toBe('open')

    clock.advance(1_000)
    expect((await gateway.judge(CALL)).status).toBe('evaluated')
    expect(gateway.breakerState(FAKE_MODEL)).toBe('closed')
  })

  test('an unusable answer never trips it — a bad rubric is not a sick provider', async () => {
    const { gateway } = gatewayFor(createFakeProvider())
    for (let i = 0; i < 10; i++) {
      await gateway.judge({ ...CALL, artifact: `${FAKE_SENTINELS.invalidOutput} ${i}` })
    }
    expect(gateway.breakerState(FAKE_MODEL)).toBe('closed')
  })

  test('the circuit is per model: one broken judge does not silence the panel', async () => {
    const { gateway } = gatewayFor(createFakeProvider())
    await gateway.judge(DOWN)

    expect(gateway.breakerState(FAKE_MODEL)).toBe('open')
    expect(gateway.breakerState('fake:other')).toBe('closed')
    expect((await gateway.judge({ ...CALL, model: 'fake:other' })).status).toBe('evaluated')
  })

  test('opening and closing are logged as the dependency events they are', async () => {
    const logger = recordingLogger()
    const { gateway, clock } = gatewayFor(createFakeProvider({ failFirst: 3 }))

    await gateway.judge(CALL, { logger })
    clock.advance(1_000)
    await gateway.judge(CALL, { logger })

    const states = logger.lines.filter((line) => line.msg.startsWith('circuit'))
    expect(states.map((line) => [line.level, line.msg])).toEqual([
      ['warn', 'circuit opened'],
      ['info', 'circuit half-open, probing'],
      ['info', 'circuit closed'],
    ])
  })
})
