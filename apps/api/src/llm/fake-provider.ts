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
  /**
   * The provider refuses in a way no retry can fix (ADR-0024) — a rejected key, in the
   * real world. NOT retried, does not count against the breaker, and logged at `error`.
   *
   * Added at M3 because it is the condition the one alert rule fires on (ADR-0043), and a
   * rule nobody can trigger is a rule nobody has tested. It is the same argument the rest
   * of this list is built on: a failure you can drive BY HAND with `curl` is one you can
   * show working on a running system, and "watch the alert fire" is precisely that kind of
   * demonstration.
   */
  misconfigured: '__misconfigured__',
} as const

/**
 * How long a fake judge takes to answer. Off unless asked for.
 *
 * **Why this exists at all: a ramp against a zero-latency fake is a benchmark of a hash
 * function.** Every queue, pool and timeout in this system is sized against a dependency
 * that takes seconds, and a load test where the dependency returns instantly measures none
 * of them — it finds the throughput of `Bun.serve`, which nobody was asking about. M2's
 * whole subject is what happens when the real thing is slow, so the fake has to be able to
 * be slow on demand.
 */
export type FakeLatency = {
  /** The centre of the distribution. */
  meanMs: number
  /** Half-width. A call takes `meanMs ± spreadMs`, drawn from the call's own hash. */
  spreadMs?: number
}

/**
 * **A measured figure, not a guess.** The table in `llm/retry.ts` records what real judges
 * actually took against a ~2,700-input-token artifact on 2026-08-30: `claude-sonnet-5` at
 * 5304 / 3829 / 4092 ms, `gemini-3.7-flash` at 2337, `gpt-5.6-sol` at 1877. Four seconds
 * sits in the middle of that, and the spread is wide enough to cover the range rather than
 * pretending every judge is identically slow.
 *
 * It is deliberately NOT the same number as `retry.ts`'s 10s `timeoutMs`. A fake that
 * always took exactly the timeout would make every load run a study of the timeout; a fake
 * at the measured latency leaves the timeout where it belongs, as the thing that catches
 * the tail.
 *
 * `retry.ts` also notes the number that should stop anyone treating this as comfortable:
 * `claude-haiku-4.5` was caught at **15092 ms** on the same probe. Latency varies far more
 * across the catalogue than within one model, and `docs/BREAKING_POINT.md` should say so.
 */
export const MEASURED_JUDGE_LATENCY: FakeLatency = { meanMs: 4_000, spreadMs: 1_500 }

export type FakeProviderOptions = {
  /**
   * Fail this many calls before answering normally. The knob retry tests turn: a real
   * provider's flakiness is not reproducible, and a test that waits for one is not a test.
   */
  failFirst?: number
  /** How those first calls fail. Defaults to the retryable kind. */
  failWith?: 'unavailable' | 'timeout' | 'invalid_output'
  /**
   * Make answering take time. **Zero by default, and that default is load-bearing**: every
   * existing test in this repo would slow to a crawl if it were not, so the knob has to be
   * something a load run turns on rather than something a test remembers to turn off.
   *
   * Distinct from `FAKE_SENTINELS.slow`, which never returns at all. That one is the
   * gateway's timeout under test; this one is a judge that is merely slow, which is the
   * ordinary case and the one a ramp needs.
   */
  latency?: FakeLatency
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

/**
 * **Deterministic per call**, drawn from the same digest the verdict is, so a load run is
 * repeatable rather than merely random: the same artifact takes the same time on every run,
 * and two runs of the same script are comparable instead of being two samples of noise.
 *
 * Two bytes rather than one, mapped to `[-1, 1]`, so the distribution has ~65k steps
 * instead of 256 — at a 1.5s spread, one byte would quantise latency into visible 12ms
 * bands, which is an artefact a p99 would show.
 */
const latencyFor = (digest: Uint8Array, { meanMs, spreadMs = 0 }: FakeLatency): number => {
  const drawn = ((byte(digest, 4) << 8) | byte(digest, 5)) / 65_535
  return Math.max(0, Math.round(meanMs + (drawn * 2 - 1) * spreadMs))
}

/**
 * Sleep, but abortable. It has to be: a latency above the gateway's `timeoutMs` must be
 * ended BY the timeout, exactly as a genuinely slow provider would be. A bare `Bun.sleep`
 * would swallow the abort and make the fake outlive the deadline that exists to bound it.
 */
const sleepOrAbort = async (ms: number, signal: AbortSignal | undefined): Promise<void> => {
  if (signal === undefined) return await Bun.sleep(ms)
  await Promise.race([Bun.sleep(ms), rejectOnAbort(signal)])
}

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
): { output: JudgeOutput; usage: { input: number; output: number }; digest: Uint8Array } => {
  const digest = sha256(canonical(call))
  const verdict = (byte(digest, 0) & 1) === 1
  // Two decimals, in [0.50, 1.00]: a spread wide enough for M5's low-confidence sampling
  // to have something to sample, without pretending to a precision it does not have.
  const confidence = Math.round((0.5 + (byte(digest, 1) / 255) * 0.5) * 100) / 100
  const reason = FAKE_REASONS[byte(digest, 2) % FAKE_REASONS.length] ?? FAKE_REASONS[0]

  return {
    // Handed back so latency is drawn from the SAME digest as the verdict — one hash per
    // call, and a fake that is deterministic in every field or in none.
    digest,
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
  latency,
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
      if (call.artifact.startsWith(FAKE_SENTINELS.misconfigured)) {
        // `raw` carries a payload exactly as the real adapter's does, so the path that
        // deliberately keeps a provider's body OUT of the logs is the path this exercises
        // too (`llm/index.ts` sets no `err` on this branch).
        throw new ProviderError('misconfigured', 'fake provider sentinel: misconfigured', {
          raw: { sentinel: FAKE_SENTINELS.misconfigured },
        })
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

      const { output, usage, digest } = derive(call)

      // AFTER the failure paths, on purpose. A `failFirst` rejection stays instant so the
      // retry tests that turn that knob do not inherit seconds of waiting, and the delay
      // lands only where a load run actually measures it: the answering path.
      if (latency !== undefined) await sleepOrAbort(latencyFor(digest, latency), call.signal)

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
