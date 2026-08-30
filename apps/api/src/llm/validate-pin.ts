import { type ModelPin, type ModelPinValidation, modelRefOf } from '@labelloop/contracts'
import { isProviderError, type ModelProvider, type ProviderFailureKind } from './provider.port.ts'

/**
 * Prove a pin is satisfiable, by using it.
 *
 * **Creation-time validation is a consequence of immutability, not an extra feature**
 * (ADR-0022). Creation is the last moment the pin can still change: after the `jdv_` is
 * written ADR-0003 freezes it, so a pin that routes nowhere is a permanently broken judge
 * rather than a bad afternoon. Validating here is what turns that into a form error at M4.
 *
 * Three things it establishes that nothing static can:
 *
 * - **The pool is not empty.** No catalogue field predicts it. `data_collection: 'deny'` is
 *   not even queryable — neither the endpoints nor the providers API exposes a data policy
 *   (ADR-0023) — so its effect on pool size is knowable only by asking.
 * - **How much failover the pin leaves.** Measured 2026-08-29, `anthropic/claude-sonnet-5`
 *   had 5 endpoints of 9 and `openai/gpt-5.6-sol` had **1 of 5**. A judge with no spare is
 *   fragile in a way one with four is not, and ADR-0022 requires that count on the row.
 * - **That the model honours the schema in the required key order.** Verified live on
 *   2026-08-30 to be a real failure mode rather than a theoretical one: `claude-haiku-4.5`
 *   advertises `structured_outputs`, is sent `maxLength: 280` under `strict: true`, and
 *   returned a ~570-character rationale on four attempts out of four.
 *
 * **It is an ORDINARY `evaluate()` call, not a new port method** (ADR-0026). The port is
 * deliberately one method; a second verb would be owed by every adapter that ever follows,
 * to serve this one caller. `ProviderResult.availableEndpoints` carries the count instead.
 */

export type ValidatePinOptions = {
  /** The same registry the gateway uses, so validation exercises the real dispatch path. */
  provider: ModelProvider
  model: string
  pin: ModelPin
  /** Injected so a stored `validated_at` is deterministic in tests. */
  now: () => Date
}

export type PinValidation =
  | { ok: true; validation: ModelPinValidation }
  /**
   * Never a thrown error. An unsatisfiable pin is an ordinary answer to an ordinary
   * question — the judge cannot be created — and M4's wizard renders `reason` beside the
   * field rather than catching an exception to discover the same thing.
   */
  | { ok: false; reason: string; kind?: ProviderFailureKind }

/**
 * A fixed, boring probe. Fixed because the question under test is whether the ROUTE and the
 * SCHEMA hold, and varying the input would vary the one thing that must not move; boring
 * because it is sent to a model whose moderation behaviour is unknown, and tripping a
 * guardrail during validation would report a routing failure that is nothing of the kind.
 */
const PROBE_QUESTION = 'Does this text describe something behaving incorrectly?'
const PROBE_ARTIFACT =
  'The export button on the reports page does nothing when clicked. Expected a CSV download; ' +
  'no file appears and no network request is issued. Reproduced on two machines.'

/** A `fake:` route has no endpoints, so there is nothing to satisfy and nothing to ask. */
const FAKE_ROUTE = 'fake'

export const validatePin = async ({
  provider,
  model,
  pin,
  now,
}: ValidatePinOptions): Promise<PinValidation> => {
  const ref = modelRefOf(model)
  if (ref === undefined) {
    return { ok: false, reason: `${model} is not a route-qualified model id` }
  }

  // Short-circuited before any call, and asserted by a test that counts HTTP requests: the
  // seed must stay free and offline on a fresh clone with no key (ADR-0009).
  if (ref.route === FAKE_ROUTE) {
    return {
      ok: true,
      validation: {
        validated_at: now().toISOString(),
        // Not 1. Zero is the honest count for a route that has no endpoints at all, and
        // inventing one would put a fake measurement in the column that exists to hold
        // real ones.
        available_endpoints: 0,
        served_by: model,
      },
    }
  }

  try {
    const result = await provider.evaluate({
      model,
      question: PROBE_QUESTION,
      artifact: PROBE_ARTIFACT,
      pin,
    })

    // A provider that answered without reporting its routing metadata has still proved the
    // pin routes — the call happened — so this is `ok` with a count of zero rather than a
    // failure. The distinction is recorded rather than smoothed over.
    return {
      ok: true,
      validation: {
        validated_at: now().toISOString(),
        available_endpoints: result.availableEndpoints ?? 0,
        served_by: result.servedBy,
      },
    }
  } catch (error) {
    if (isProviderError(error)) {
      // Named, and mapped to what a human can act on. `unavailable` is the one that
      // usually means the pin itself: ADR-0023's revisit trigger is precisely a model
      // returning 503 here because nothing routes under `deny`.
      return {
        ok: false,
        kind: error.kind,
        reason: REASONS[error.kind],
      }
    }
    // The adapter broke its own contract. Still not thrown: the caller asked whether the
    // pin is usable, and "we could not find out" is an answer to that.
    return { ok: false, reason: 'the provider adapter failed unexpectedly' }
  }
}

/**
 * What each failure means for the PIN specifically, rather than for the call. The gateway's
 * taxonomy answers "should this be retried"; this answers "can this judge exist", which is
 * a different question with different words.
 */
const REASONS: Record<ProviderFailureKind, string> = {
  unavailable:
    'no endpoint could serve this pin — the model, its capabilities, its data-collection ' +
    'stance and its quantizations may have no overlap',
  invalid_output:
    'the model answered, and its answer did not match the judge schema in the required ' +
    'order — reasoning must be generated before the verdict',
  timeout: 'the model did not answer in time, so the pin could not be confirmed',
  misconfigured:
    'the provider rejected the request itself — check the credential, the balance, and ' +
    'whether this model permits the pinned reasoning effort',
}
