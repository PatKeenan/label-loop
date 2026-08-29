import { beforeEach, describe, expect, test } from 'bun:test'
import { createFixedClock } from '../adapters/fixed-clock.ts'
import { recordingSpans } from '../testing/recording-spans.ts'
import { createFakeProvider, FAKE_MODEL, FAKE_SENTINELS } from './fake-provider.ts'
import { createModelGateway } from './index.ts'
import { type ModelProvider, ProviderError } from './provider.port.ts'

/**
 * What one judge call looks like in Tempo.
 *
 * The shape is the assertion: a `judge` span with an attempt span per provider call
 * beneath it. A flat span would say a judge took four seconds; this says it was called
 * three times with backoff between, which is the difference between an observation and a
 * diagnosis. Every case below is one a reader of a trace has to be able to tell apart.
 */

const CALL = {
  model: FAKE_MODEL,
  question: 'Does this issue report something behaving incorrectly?',
  artifact: 'Login button does nothing on Safari 17.',
}

const IDENTITY = { slug: 'is-bug', judgeVersionId: 'jdv_01EXAMPLE' }

let spans: ReturnType<typeof recordingSpans>
beforeEach(() => {
  spans = recordingSpans()
})

const gatewayFor = (provider: ModelProvider = createFakeProvider()) =>
  createModelGateway({
    provider,
    clock: createFixedClock(),
    tracer: spans.tracer,
    retryPolicy: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 800, timeoutMs: 50 },
    breakerPolicy: { failureThreshold: 3, openMs: 1_000 },
    random: () => 1,
  })

describe('a judge call that succeeds', () => {
  test('is one judge span over one attempt span, carrying model, tokens and cost', async () => {
    const outcome = await gatewayFor().judge(CALL, IDENTITY)
    expect(outcome.status).toBe('evaluated')

    const [judge] = spans.named('judge is-bug')
    const [attempt] = spans.named(`provider call ${FAKE_MODEL}`)

    expect(judge?.attributes).toMatchObject({
      'gen_ai.system': 'fake',
      'gen_ai.request.model': FAKE_MODEL,
      'gen_ai.response.model': FAKE_MODEL,
      'labelloop.judge_slug': 'is-bug',
      'labelloop.judge_version_id': 'jdv_01EXAMPLE',
      'labelloop.outcome': 'evaluated',
      'labelloop.attempts': 1,
    })
    // The numbers M2's metering and M7's model-swap argument are both made of. Asserted as
    // "present and positive" rather than as literals, because the fake's token counts are
    // its business and the point here is that the span carries them at all.
    expect(judge?.attributes['gen_ai.usage.input_tokens']).toBeGreaterThan(0)
    expect(judge?.attributes['gen_ai.usage.output_tokens']).toBeGreaterThan(0)
    // The fake model is priced at zero, and it is priced — which is a different fact from
    // a model whose price nobody has entered. The span says which, so M2 can sum one and
    // refuse to sum the other.
    expect(judge?.attributes['labelloop.cost_usd']).toBe(0)
    expect(judge?.attributes['labelloop.cost_priced']).toBe(true)

    // The link that makes it a tree rather than two unrelated spans.
    expect(attempt?.parentSpanContext?.spanId).toBe(judge?.spanContext().spanId ?? '')
    expect(attempt?.spanContext().traceId).toBe(judge?.spanContext().traceId ?? '')
  })

  test('carries no question, artifact or context — telemetry is metadata, not content', async () => {
    await gatewayFor().judge({ ...CALL, context: { customer_email: 'ada@example.com' } }, IDENTITY)

    const serialized = JSON.stringify(spans.spans().map((span) => span.attributes))
    expect(serialized).not.toContain('ada@example.com')
    expect(serialized).not.toContain('Login button')
    expect(serialized).not.toContain(CALL.question)
  })
})

describe('a judge call that has to retry', () => {
  test('shows one attempt span per provider call, with the backoff between them', async () => {
    const outcome = await gatewayFor(createFakeProvider({ failFirst: 2 })).judge(CALL, IDENTITY)
    expect(outcome.status).toBe('evaluated')

    const attempts = spans.named(`provider call ${FAKE_MODEL}`)
    expect(attempts).toHaveLength(3)
    expect(attempts.map((span) => span.attributes['labelloop.attempts'])).toEqual([1, 2, 3])
    // The two that failed say why, and say it on the attempt rather than on the parent —
    // which is what lets a reader see that attempt 2 timed out and attempt 3 did not.
    expect(attempts.slice(0, 2).map((span) => span.attributes['labelloop.failure_kind'])).toEqual([
      'unavailable',
      'unavailable',
    ])
    expect(attempts.map((span) => span.status.code)).toEqual([2, 2, 0])

    const [judge] = spans.named('judge is-bug')
    expect(judge?.attributes['labelloop.attempts']).toBe(3)
    // The backoff is a GAP between attempts, so it is marked as an event on the parent.
    // Without it a trace shows three quick calls and a slow judge with no visible reason.
    expect(judge?.events.map((event) => event.name)).toEqual(['backoff', 'backoff'])
    expect(judge?.events[0]?.attributes).toMatchObject({
      'labelloop.attempts': 1,
      'labelloop.failure_kind': 'unavailable',
    })
    expect(judge?.events[0]?.attributes?.['labelloop.backoff_ms']).toBeGreaterThan(0)
  })
})

describe('a judge call the circuit refuses', () => {
  test('produces a judge span with NO attempt span beneath it, because nobody was called', async () => {
    const gateway = gatewayFor()
    const down = { ...CALL, artifact: `${FAKE_SENTINELS.unavailable} down` }

    // Three failures trip the breaker; the fourth call never reaches the provider.
    await gateway.judge(down, IDENTITY)
    spans.reset()
    const refused = await gateway.judge(CALL, IDENTITY)

    expect(refused).toMatchObject({ status: 'error', code: 'CIRCUIT_OPEN', attempts: 0 })
    expect(spans.named(`provider call ${FAKE_MODEL}`)).toHaveLength(0)

    const [judge] = spans.named('judge is-bug')
    expect(judge?.attributes).toMatchObject({
      'labelloop.outcome': 'error',
      'labelloop.error_code': 'CIRCUIT_OPEN',
      'labelloop.failure_kind': 'circuit_open',
      'labelloop.attempts': 0,
    })
    expect(judge?.status.code).toBe(2)
  })
})

describe('a judge whose answer was unusable', () => {
  test('is not an ERROR span — the call worked and the rubric did not', async () => {
    const outcome = await gatewayFor().judge(
      { ...CALL, artifact: `${FAKE_SENTINELS.invalidOutput} nonsense` },
      IDENTITY,
    )
    expect(outcome.status).toBe('failed')

    const [judge] = spans.named('judge is-bug')
    expect(judge?.attributes['labelloop.outcome']).toBe('failed')
    // UNSET, not ERROR. A prompt that needs rewriting is not an incident, and colouring it
    // like one is how a team learns to ignore the colour.
    expect(judge?.status.code).toBe(0)
    expect(judge?.attributes['labelloop.error_code']).toBeUndefined()
  })
})

describe('a judge the provider will never accept', () => {
  test('leaves ONE attempt span, named as misconfigured — the alert query M3 needs', async () => {
    const provider: ModelProvider = {
      name: 'unhappy',
      evaluate: () => Promise.reject(new ProviderError('misconfigured', 'no credentials')),
    }
    const outcome = await gatewayFor(provider).judge(CALL, IDENTITY)
    expect(outcome.status).toBe('error')

    const attempts = spans.named(`provider call ${FAKE_MODEL}`)
    // One, not three. The span count is the retry policy made visible: this is the shape
    // that distinguishes "the provider is flaky" from "we did not pay the bill".
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.attributes['labelloop.failure_kind']).toBe('misconfigured')

    const [judge] = spans.named('judge is-bug')
    expect(judge?.attributes['labelloop.error_code']).toBe('INTERNAL')
    expect(judge?.attributes['labelloop.attempts']).toBe(1)
    expect(judge?.status.code).toBe(2)
  })

  test('puts none of the provider’s payload on a span — a span is read by more people', async () => {
    const artifact = 'Login button does nothing on Safari 17.'
    const provider: ModelProvider = {
      name: 'unhappy',
      evaluate: () =>
        Promise.reject(
          new ProviderError('misconfigured', 'bad request', {
            raw: { error: { code: 400, metadata: { flagged_input: artifact } } },
          }),
        ),
    }
    await gatewayFor(provider).judge({ ...CALL, artifact }, IDENTITY)

    const serialized = JSON.stringify(
      spans.spans().map((span) => ({ attributes: span.attributes, status: span.status })),
    )
    expect(serialized).not.toContain('Safari')
    expect(serialized).not.toContain('flagged_input')
    // The status message is ours, not the provider's — asserted so a future change that
    // forwards the provider's message into it fails here rather than in production.
    expect(serialized).not.toContain('bad request')
  })
})

describe('a judge span without an identity', () => {
  test('falls back to the model in its name and omits the judge attributes', async () => {
    await gatewayFor().judge(CALL)

    const [judge] = spans.named(`judge ${FAKE_MODEL}`)
    expect(judge).toBeDefined()
    expect(judge?.attributes['labelloop.judge_slug']).toBeUndefined()
    expect(judge?.attributes['labelloop.judge_version_id']).toBeUndefined()
  })
})
