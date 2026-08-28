import type { JudgeOutput } from '@labelloop/contracts'
import type { JudgeCall, ModelProvider, ProviderResult } from './provider.port.ts'
import { ProviderError } from './provider.port.ts'

/**
 * The deterministic fake, and a *peer* of the real adapter rather than a stub of it: it
 * implements the same port and passes the same contract suite, so M1 is an adapter swap
 * and not a rewrite of the path (plan P4's slice goal).
 *
 * It reads nothing and judges nothing. Every field it returns is derived from a SHA-256
 * of the call, so the same input yields the same verdict, confidence and token counts
 * forever — which is what lets the whole evaluation path be asserted end to end without a
 * network, a key, or a bill. Its rationale says so out loud, because a plausible-sounding
 * sentence from a fake judge is exactly the artefact someone screenshots by mistake.
 */

/** The model the seed configures its judges with, and what this adapter answers to. */
export const FAKE_MODEL = 'fake:deterministic'

/** Anything under this namespace is ours; anything else is `unavailable` (the contract). */
const FAKE_MODEL_PREFIX = 'fake:'

/**
 * Sentinels, and the reason they exist: the resilience path has to be demonstrable BY
 * HAND, not only from a test. An artifact beginning with one of these drives the fake
 * into a specific failure, so `curl` can show backoff, a tripped breaker, or a timeout
 * on a running system (plan P4's manual verification).
 *
 * They live on the fake and die with it at M1. A real provider has real failures.
 */
export const FAKE_SENTINELS = {
  /** The call does not complete. Retried, then it trips the breaker. */
  unavailable: '__unavailable__',
  /** The call completes and the answer is unusable. NOT retried — a rubric problem. */
  invalidOutput: '__invalid__',
  /** The call never returns, so the gateway's timeout is what ends it. */
  slow: '__slow__',
} as const

export type FakeProviderOptions = {
  /**
   * Fail this many calls before answering normally. The knob retry tests turn: a real
   * provider's flakiness is not reproducible, and a test that waits for one is not a test.
   */
  failFirst?: number
  /** How those first calls fail. Defaults to the retryable kind. */
  failWith?: 'unavailable' | 'timeout' | 'invalid_output'
}

const sha256 = (value: string): Uint8Array =>
  new Uint8Array(new Bun.CryptoHasher('sha256').update(value).digest().buffer)

/** Context is a record, so its key order is not meaningful — sort it or lose determinism. */
const canonical = (call: JudgeCall): string => {
  const context = Object.entries(call.context ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(' ')
  return [call.model, call.question, call.artifact, context].join(' ')
}

const byte = (digest: Uint8Array, index: number): number => digest[index] ?? 0

/**
 * Placeholder codes, deliberately prefixed. Real reasons are drawn from a panel's
 * versioned `tax_` taxonomy (M5); these are not that, and should never be mistaken for it.
 */
const FAKE_REASONS = ['fake-strong-signal', 'fake-weak-signal', 'fake-ambiguous'] as const

const rejectOnAbort = (signal: AbortSignal): Promise<never> =>
  new Promise((_, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new ProviderError('timeout', 'the fake provider was aborted')),
      { once: true },
    )
  })

const derive = (
  call: JudgeCall,
): { output: JudgeOutput; usage: { input: number; output: number } } => {
  const digest = sha256(canonical(call))
  const verdict = (byte(digest, 0) & 1) === 1
  // Two decimals, in [0.50, 1.00]: a spread wide enough for M5's low-confidence sampling
  // to have something to sample, without pretending to a precision it does not have.
  const confidence = Math.round((0.5 + (byte(digest, 1) / 255) * 0.5) * 100) / 100
  const reason = FAKE_REASONS[byte(digest, 2) % FAKE_REASONS.length] ?? FAKE_REASONS[0]

  return {
    output: {
      rationale:
        'Deterministic stand-in for a judge: this verdict is a hash of the call, not a ' +
        'reading of the artifact. No model was asked anything.',
      // Only a `true` verdict carries reasons, mirroring how a real judge behaves: the
      // codes name what was found, and finding nothing has nothing to name.
      reasons: verdict ? [reason] : [],
      verdict,
      confidence,
    },
    usage: {
      // Roughly four characters to a token, which is the usual English approximation and
      // close enough for a number nothing is billed against.
      input: Math.max(1, Math.ceil((call.question.length + call.artifact.length) / 4)),
      output: 20 + (byte(digest, 3) % 40),
    },
  }
}

export const createFakeProvider = ({
  failFirst = 0,
  failWith = 'unavailable',
}: FakeProviderOptions = {}): ModelProvider & { readonly calls: number } => {
  let calls = 0

  return {
    name: 'fake',

    evaluate: async (call: JudgeCall): Promise<ProviderResult> => {
      calls += 1

      // Checked before anything else: an adapter that answers an already-aborted call has
      // silently unbounded the timeout that aborted it.
      if (call.signal?.aborted === true) {
        throw new ProviderError('timeout', 'the fake provider was aborted before it started')
      }
      if (!call.model.startsWith(FAKE_MODEL_PREFIX)) {
        throw new ProviderError('unavailable', `no fake model named ${call.model}`)
      }
      if (calls <= failFirst) {
        throw new ProviderError(failWith, `fake failure ${calls} of ${failFirst}`)
      }

      if (call.artifact.startsWith(FAKE_SENTINELS.unavailable)) {
        throw new ProviderError('unavailable', 'fake provider sentinel: unavailable')
      }
      if (call.artifact.startsWith(FAKE_SENTINELS.invalidOutput)) {
        throw new ProviderError('invalid_output', 'fake provider sentinel: unusable answer', {
          raw: { sentinel: FAKE_SENTINELS.invalidOutput },
        })
      }
      if (call.artifact.startsWith(FAKE_SENTINELS.slow)) {
        // Never settles on its own. Whatever ends this call comes from outside it, which
        // is the point: it is the gateway's timeout under test, not the fake's patience.
        await (call.signal === undefined
          ? new Promise<never>(() => {})
          : rejectOnAbort(call.signal))
      }

      const { output, usage } = derive(call)
      return {
        output,
        usage,
        servedBy: call.model,
        // Shaped like a provider envelope rather than like our normalised fields, so the
        // stored raw payload is genuinely a second representation and not a copy.
        raw: { provider: 'fake', model: call.model, output, usage },
      }
    },

    get calls() {
      return calls
    },
  }
}
