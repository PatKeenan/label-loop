import { describe, expect, test } from 'bun:test'
import { CAPABILITY_STRUCTURED_OUTPUTS, DEFAULT_FAKE_PIN } from '@labelloop/contracts'
import { createFakeProvider } from '../apps/api/src/llm/fake-provider.ts'
import { createOpenRouterProvider } from '../apps/api/src/llm/openrouter-provider.ts'
import { createProviderRegistry } from '../apps/api/src/llm/provider-registry.ts'
import {
  DEFAULT_SEED_MODEL,
  JUDGES,
  MODEL_VARS,
  type ModelVar,
  pinFor,
  resolveSeededJudges,
  type SeededJudge,
  validateSeededPins,
} from './seed-judges.ts'

/**
 * The seed's decisions, tested without a database and without a bill.
 *
 * Two of the claims here are the ones that would otherwise be discovered in production:
 * that a fresh clone with no key stays free and offline, and that a judge whose pin cannot
 * route stops the seed by name instead of freezing a `jdv_` that can never work.
 */

const GEMINI = 'openrouter:google/gemini-3.7-flash'
const SONNET = 'openrouter:anthropic/claude-sonnet-5'

/** A key-shaped string. Never a real one — this file makes no call that would use it. */
const A_KEY = 'sk-or-v1-not-a-real-key'

const bySlug = (judges: SeededJudge[], slug: string): SeededJudge => {
  const found = judges.find((judge) => judge.slug === slug)
  if (found === undefined) throw new Error(`no seeded judge named ${slug}`)
  return found
}

describe('resolveSeededJudges', () => {
  test('with nothing set, every judge is the deterministic fake (ADR-0009)', () => {
    const judges = resolveSeededJudges({})
    expect(judges).toHaveLength(JUDGES.length)
    expect(judges.map((judge) => judge.model)).toEqual(JUDGES.map(() => DEFAULT_SEED_MODEL))
    // The default pin, not a pin that happens to look like it: a `fake:` route has no
    // endpoints to constrain, and it carries one only so the CHECK can be the clean mirror
    // of the model/type rule (ADR-0025).
    for (const judge of judges) expect(judge.pin).toEqual(DEFAULT_FAKE_PIN)
  })

  test('an empty string is treated as unset, which is the shape compose passes', () => {
    expect(resolveSeededJudges({ SEED_MODEL_A: '' })[0]?.model).toBe(DEFAULT_SEED_MODEL)
  })

  // GONE FOR ONE PR, and recorded rather than silently dropped: "the three variables pin
  // four judges across three labs" cannot be written against the one-judge placeholder
  // panel ADR-0034 left behind, and `resolveSeededJudges` reads the module-level `JUDGES`
  // so there is no seam to inject a multi-judge fixture without changing its signature.
  // What is lost is narrow — that several judges resolve to several different models —
  // and it returns at P2 with the replacement panel. The fallback, the empty-string case,
  // the unqualified-value message and the missing-key refusal are all still covered below.

  test('a configured variable is used verbatim, and only for the judge that names it', () => {
    const judges = resolveSeededJudges({ OPENROUTER_API_KEY: A_KEY, SEED_MODEL_A: SONNET })
    expect(bySlug(judges, 'needs-human').model).toBe(SONNET)
  })

  test('a model that is not route-qualified fails naming the VARIABLE, not the value', () => {
    // `modelRefOf` answers `undefined` rather than a reason precisely so its caller — which
    // is the only thing that knows a variable name — can write the message.
    //
    // Driven through `SEED_MODEL_A` because that is the variable the placeholder panel
    // actually reads: a value set on a variable no judge names is not resolved at all, so
    // pointing this at B or C would assert nothing. P2 widens it again.
    expect(() => resolveSeededJudges({ SEED_MODEL_A: 'claude-sonnet-5' })).toThrow(/SEED_MODEL_A/)
    expect(() => resolveSeededJudges({ SEED_MODEL_A: 'claude-sonnet-5' })).toThrow(
      /route-qualified/,
    )
  })

  test('a remote model with no key fails naming the key AND the variable', () => {
    // Without this the registry would answer `unavailable` and validation would report
    // "no endpoint could serve this pin" — true about routing, and the wrong answer to why.
    try {
      resolveSeededJudges({ SEED_MODEL_A: GEMINI })
      throw new Error('expected resolveSeededJudges to throw')
    } catch (error) {
      expect((error as Error).message).toContain('OPENROUTER_API_KEY')
      expect((error as Error).message).toContain('SEED_MODEL_A')
    }
  })

  test('every judge names one of the three variables — no fourth knob crept in', () => {
    // A subset rather than an equality: the placeholder panel holds one judge, so not
    // every variable is currently read. What must stay true is that no judge reaches for
    // a knob outside the three (P2 restores the full spread).
    const named = new Set<string>(JUDGES.map((judge) => judge.modelVar))
    expect([...named].every((variable) => MODEL_VARS.includes(variable as ModelVar))).toBe(true)
  })
})

/**
 * Decision 17 and ADR-0025, which is the one place the pin's meaning could quietly change
 * under a frozen row. `google/gemini-3.7-flash` reports `reasoning.mandatory: true`, so
 * `none` is a hard 400 from the provider and something had to be chosen; the stakeholder's
 * call was the model's own default, written in as a LITERAL.
 */
describe('pinFor — the effort is always a concrete literal', () => {
  test('every other model is pinned to `none`, so nothing deliberates unseen', () => {
    expect(pinFor(SONNET)).toEqual({
      capabilities: [CAPABILITY_STRUCTURED_OUTPUTS],
      data_collection: 'deny',
      reasoning: { effort: 'none' },
    })
  })

  test('gemini-3.7-flash carries `medium` — its own default, read on 2026-08-30', () => {
    // Not an absent field. Omitting it would let OpenRouter decide, which would make this
    // frozen `jdv_` silently re-mean itself the day the provider moved its default — the
    // exact drift ADR-0022 exists against. If they change it, ours does not move.
    expect(pinFor(GEMINI).reasoning.effort).toBe('medium')
  })

  test('every pin denies data collection, on every row (ADR-0023)', () => {
    for (const model of [SONNET, GEMINI, DEFAULT_SEED_MODEL]) {
      expect(pinFor(model).data_collection).toBe('deny')
    }
  })

  test('quantizations is omitted — hosted proprietary routes have none to constrain', () => {
    expect(pinFor(SONNET).quantizations).toBeUndefined()
  })
})

describe('validateSeededPins', () => {
  test('an all-fake seed makes ZERO HTTP calls — a fresh clone stays free and offline', async () => {
    let calls = 0
    const provider = createProviderRegistry({
      providers: {
        fake: createFakeProvider(),
        // Registered, and counting. If the fake route ever stopped short-circuiting, this
        // is the assertion that notices rather than the credit-card statement.
        openrouter: createOpenRouterProvider({
          apiKey: A_KEY,
          // Cast as the adapter's own tests cast it: `typeof fetch` carries Bun's
          // `preconnect`, which a stub has no business implementing.
          fetch: (() => {
            calls += 1
            throw new Error('the seed must not call a provider for a fake: judge')
          }) as unknown as typeof globalThis.fetch,
        }),
      },
    })

    const validations = await validateSeededPins({
      judges: resolveSeededJudges({}),
      provider,
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    })

    expect(calls).toBe(0)
    expect(validations.size).toBe(JUDGES.length)
    // Zero is the honest count for a route with no endpoints at all. Inventing a 1 would
    // put a fake measurement in the column that exists to hold real ones.
    expect(validations.get('needs-human')?.available_endpoints).toBe(0)
    expect(validations.get('needs-human')?.validated_at).toBe('2026-08-30T12:00:00.000Z')
  })

  test('a pin that cannot route fails the whole seed, naming the judge', async () => {
    // The permanence is why there is no switch: ADR-0003 freezes the row, so a judge
    // seeded against a pin that routes nowhere cannot be repaired, only replaced.
    const provider = createProviderRegistry({
      providers: {
        fake: createFakeProvider(),
        openrouter: createOpenRouterProvider({
          apiKey: A_KEY,
          fetch: (() =>
            Promise.resolve(
              new Response(
                JSON.stringify({ error: { message: 'No endpoints found', code: 404 } }),
                {
                  status: 404,
                  headers: { 'content-type': 'application/json' },
                },
              ),
            )) as unknown as typeof globalThis.fetch,
        }),
      },
    })

    const judges = resolveSeededJudges({ OPENROUTER_API_KEY: A_KEY, SEED_MODEL_A: GEMINI })

    // Awaited, deliberately: an unawaited `.rejects` assertion resolves after the test has
    // already passed, which is a test that cannot fail.
    await expect(validateSeededPins({ judges, provider, now: () => new Date() })).rejects.toThrow(
      /needs-human/,
    )
  })

  test('only the judges it is given are validated — which is what keeps a re-run free', async () => {
    let calls = 0
    const provider = createProviderRegistry({
      providers: {
        fake: {
          name: 'counting-fake',
          evaluate: (call) => {
            calls += 1
            return createFakeProvider().evaluate(call)
          },
        },
      },
    })
    // The empty list is the second run: every `jdv_` is already frozen, so there is
    // nothing left to establish and nothing to buy.
    const validations = await validateSeededPins({ judges: [], provider, now: () => new Date() })
    expect(validations.size).toBe(0)
    expect(calls).toBe(0)
  })
})
