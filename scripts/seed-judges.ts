import {
  CAPABILITY_STRUCTURED_OUTPUTS,
  DEFAULT_FAKE_PIN,
  type ModelPin,
  type ModelPinValidation,
  modelPinSchema,
  modelRefOf,
  type ReasoningEffort,
} from '@labelloop/contracts'
import type { ModelProvider } from '../apps/api/src/llm/provider.port.ts'
import { validatePin } from '../apps/api/src/llm/validate-pin.ts'

/**
 * Which judges the seed creates, which model each one asks, and the pin each one is frozen
 * against — separated from `seed.ts` because everything here is decidable without a
 * database, and a decision that costs money should be testable without one.
 *
 * **One code path, not two** (M1/P5). There is no branch on whether a key exists: every
 * judge reads a `SEED_MODEL_*` variable that defaults to `fake:deterministic`, so a fresh
 * clone gets a free, deterministic, zero-secret boot and anyone holding a key gets a
 * genuine three-lab demo from the same lines. A seed that branched would mean the free
 * path and the paid path were different code, and only one of them ever exercised.
 */

/**
 * Restated rather than imported, as `repositories/panels.ts` restates it: the union lives
 * in the database as a pgEnum, and reaching for it here would pull the whole schema — and
 * a driver — into the one module in this pair that decides everything without a database.
 */
export type JudgePolarity = 'passes' | 'fails' | 'does_not_score'

export type JudgeSeed = {
  slug: string
  name: string
  question: string
  polarity: JudgePolarity
  weight: number | null
  required: boolean
  /**
   * The environment variable naming this judge's model. Two judges share `SEED_MODEL_A`
   * on purpose — four judges across three labs is what makes the price and latency
   * differences legible, and a fourth variable would have implied a fourth lab.
   */
  modelVar: ModelVar
}

/** The three knobs, so a caller can set them all without reading this file. */
export const MODEL_VARS = ['SEED_MODEL_A', 'SEED_MODEL_B', 'SEED_MODEL_C'] as const

export type ModelVar = (typeof MODEL_VARS)[number]

/**
 * The value every model variable falls back to, and the reason the seed needs no key.
 * `fake:deterministic` derives its verdict from a hash of the call rather than by reading
 * anything, so the whole evaluation path runs offline and free.
 */
export const DEFAULT_SEED_MODEL = 'fake:deterministic'

/**
 * The seeded panel is the one PRODUCT.md names as tenant #1 — issue triage — because it is
 * the case that exercises all three polarities. Three of its judges are informational
 * labels with no valence, and one is a real gate; a panel of a single scoring judge would
 * have demonstrated none of that.
 */
export const JUDGES: JudgeSeed[] = [
  {
    slug: 'is-bug',
    name: 'Is a bug report',
    question: 'Does this issue report something behaving incorrectly?',
    // A label with no valence: it is neither a pass nor a failure, so it scores nothing
    // and is absent from both the numerator and the denominator (ADR-0019).
    polarity: 'does_not_score',
    weight: null,
    required: false,
    modelVar: 'SEED_MODEL_A',
  },
  {
    slug: 'is-feature',
    name: 'Is a feature request',
    question: 'Does this issue ask for behaviour that does not exist yet?',
    polarity: 'does_not_score',
    weight: null,
    required: false,
    modelVar: 'SEED_MODEL_B',
  },
  {
    slug: 'is-question',
    name: 'Is a question',
    question: 'Is this issue asking how to do something, rather than reporting a problem?',
    polarity: 'does_not_score',
    weight: null,
    required: false,
    modelVar: 'SEED_MODEL_C',
  },
  {
    slug: 'needs-human',
    name: 'Needs a human',
    question: 'Does this issue need a maintainer to read it before any automated reply?',
    // The one real gate on the panel. Answering `true` FAILS, and it is required — a veto,
    // which is how `weighted_threshold` expresses that policy without a second code path.
    polarity: 'fails',
    weight: 1,
    required: true,
    modelVar: 'SEED_MODEL_A',
  },
]

/**
 * Models whose reasoning cannot be switched off, and the effort each one is pinned to.
 *
 * **Read from `reasoning.default_effort` on the models API on 2026-08-30, and written here
 * as a literal.** That distinction is the whole point (ADR-0025). `google/gemini-3.7-flash`
 * reports `reasoning.mandatory: true`, so the `none` every other judge carries is a hard
 * 400 from the provider — *"Reasoning is mandatory for this endpoint and cannot be
 * disabled"* — and something had to be chosen. The stakeholder's call was to use the
 * model's own default rather than to pick a cheaper one for it.
 *
 * "Use the default" then means the value it had on the day it was seeded, frozen. It does
 * NOT mean omitting the field and letting the provider decide, which would make a frozen
 * `jdv_` silently re-mean itself the day OpenRouter moved its default — precisely the drift
 * ADR-0022 was written against. If the provider changes its default, ours does not move and
 * the divergence is visible.
 *
 * Anything absent from this table is pinned to `none`, and a model that is absent and
 * mandatory fails at seed time rather than at the first customer request. That is the
 * correct trade: the failure is loud, immediate, and names the judge.
 */
export const PINNED_EFFORTS: Readonly<Record<string, ReasoningEffort>> = {
  'openrouter:google/gemini-3.7-flash': 'medium',
}

/**
 * `none` where the model permits it, because hidden deliberation defeats the
 * reasoning-before-verdict ordering the judge output schema exists to force: the model
 * settles the verdict during the part we cannot see, store, show an annotator, or correct.
 */
export const DEFAULT_EFFORT: ReasoningEffort = 'none'

export type SeededJudge = JudgeSeed & {
  /** Route-qualified, `<route>:<native-id>` — what goes in `judge_versions.model`. */
  model: string
  /** What goes in `judge_versions.model_pin`, with every default resolved to a literal. */
  pin: ModelPin
}

/**
 * The pin a given model is frozen against.
 *
 * A `fake:` route has no endpoints to constrain, so it gets the shared default rather than
 * a pin assembled to constrain nothing — but it gets one, because every `llm` judge carries
 * a pin (ADR-0025) so the database CHECK can be the clean mirror of the model/type rule.
 */
export const pinFor = (model: string): ModelPin => {
  if (modelRefOf(model)?.route === 'fake') return DEFAULT_FAKE_PIN
  return modelPinSchema.parse({
    // At M1 this is the only capability, and the reason the pin exists: a judge that
    // cannot be held to a schema is not a judge.
    capabilities: [CAPABILITY_STRUCTURED_OUTPUTS],
    // ADR-0023. One writable value, written as a value on every row.
    data_collection: 'deny',
    reasoning: { effort: PINNED_EFFORTS[model] ?? DEFAULT_EFFORT },
  })
}

/**
 * Read the environment and answer what the four judges are, or throw naming the variable
 * that is wrong.
 *
 * It names the VARIABLE rather than the value, which is what CONVENTIONS' "crash at
 * startup with a named field" actually requires — `modelRefOf` answers `undefined` rather
 * than a reason precisely so its caller, which knows what it was reading, can say so.
 */
export const resolveSeededJudges = (
  env: Record<string, string | undefined> = process.env,
): SeededJudge[] => {
  const judges = JUDGES.map((judge) => {
    const configured = env[judge.modelVar]
    const model = configured === undefined || configured === '' ? DEFAULT_SEED_MODEL : configured
    if (modelRefOf(model) === undefined) {
      throw new Error(
        `${judge.modelVar}="${model}" is not a route-qualified model id — ` +
          `expected <route>:<id>, as in "${DEFAULT_SEED_MODEL}" or ` +
          '"openrouter:anthropic/claude-sonnet-5"',
      )
    }
    return { ...judge, model, pin: pinFor(model) }
  })

  // Said here rather than discovered as an `unavailable` from the registry three lines
  // later. Without a key the OpenRouter adapter is never registered, so the pin would fail
  // to validate with "no endpoint could serve this pin" — a true sentence about routing
  // that is the wrong answer to why, and one nobody would act on correctly.
  const remote = judges.filter((judge) => modelRefOf(judge.model)?.route !== 'fake')
  if (remote.length > 0 && (env.OPENROUTER_API_KEY ?? '') === '') {
    const named = [...new Set(remote.map((judge) => `${judge.modelVar}=${judge.model}`))]
    throw new Error(
      `OPENROUTER_API_KEY is not set, and ${named.join(', ')} names a model that needs it. ` +
        `Set the key, or leave the SEED_MODEL_* variables unset to seed ${DEFAULT_SEED_MODEL}.`,
    )
  }

  return judges
}

export type ValidateSeededPinsOptions = {
  /** Only the judges whose `jdv_` does not exist yet — see `validateSeededPins` on why. */
  judges: readonly SeededJudge[]
  /** The same registry the gateway uses, so this exercises the real dispatch path. */
  provider: ModelProvider
  now: () => Date
}

/**
 * Prove every pin routes, before any of them freezes — and fail the whole seed when one
 * does not (ADR-0026).
 *
 * **There is no escape hatch, and that is a decision rather than an omission.** It couples
 * the seed, and therefore compose's `migrate` one-shot, to OpenRouter's availability. The
 * trade is accepted because a judge whose pin routes nowhere is *permanently* broken by
 * construction: ADR-0003 freezes the row, so the failure it prevents cannot be repaired,
 * only replaced. A deploy that refuses is better than a panel that 503s per call, and a
 * safety check with a switch is a safety check that gets switched off the first busy
 * afternoon.
 *
 * It is given only the judges that do not exist yet, which is what keeps the seed
 * idempotent in the sense that matters: a second run is free, silent, and makes no network
 * call, rather than re-buying a fact about a row that froze days ago.
 */
export const validateSeededPins = async ({
  judges,
  provider,
  now,
}: ValidateSeededPinsOptions): Promise<Map<string, ModelPinValidation>> => {
  const validations = new Map<string, ModelPinValidation>()
  // Sequential rather than concurrent, deliberately: these are real calls against one
  // account, and the first failure should stop the seed rather than race three more
  // billable requests it has already decided to throw away.
  for (const judge of judges) {
    const result = await validatePin({ provider, model: judge.model, pin: judge.pin, now })
    if (!result.ok) {
      throw new Error(
        `judge "${judge.slug}" cannot be seeded: ${judge.model} ` +
          `(${judge.modelVar}) did not validate — ${result.reason}`,
      )
    }
    validations.set(judge.slug, result.validation)
  }
  return validations
}
