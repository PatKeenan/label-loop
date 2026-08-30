import { z } from '@hono/zod-openapi'
import { judgeOutputSchema } from '@labelloop/contracts'

/**
 * The judge's structured-output schema, on the wire.
 *
 * **It is DERIVED from `judgeOutputSchema`, never hand-written.** The contract is the
 * single source of type truth (CONVENTIONS.md), and a second copy of it shaped for a
 * provider is a copy that drifts — silently, because both halves keep parsing. Deriving
 * makes drift impossible rather than merely unlikely: change the contract and this moves
 * with it, or the assertions beside it fail.
 *
 * **Property order is load-bearing here, not cosmetic.** Under structured output the
 * schema's order determines generation order, and these models are autoregressive — so
 * `rationale` → `reasons` → `verdict` → `confidence` is the difference between a judge
 * that thinks before deciding and one that rationalises after (ADR-0019). JSON object key
 * order is preserved through `JSON.stringify`, so the derived schema carries the
 * contract's order to the provider unchanged.
 */

/** The contract's order, spelled out so it can be asserted rather than assumed. */
export const JUDGE_OUTPUT_KEYS = ['rationale', 'reasons', 'verdict', 'confidence'] as const

export type JudgeOutputKey = (typeof JUDGE_OUTPUT_KEYS)[number]

/**
 * `io: 'output'` because this describes what the model must PRODUCE. The distinction
 * matters for any field carrying a default: the input side would mark it optional, and an
 * optional field under a strict schema is a field the model may decline to emit.
 */
const derived = z.toJSONSchema(judgeOutputSchema, { io: 'output' }) as Record<string, unknown>

/**
 * `$schema` is a document-level declaration, not a constraint on the value, and providers
 * validating a strict schema have no use for it. Dropped rather than passed through, so
 * the request body carries only what constrains the answer.
 */
const { $schema: _dialect, ...body } = derived

/**
 * The schema sent to the provider.
 *
 * The last two properties are re-asserted rather than trusted: Zod supplies both today,
 * and both are the kind of thing a minor version could reasonably change. `strict: true`
 * on the provider side is only as good as the schema it is given — a schema that permits
 * extra properties or omits a required one is one the model can satisfy while telling us
 * nothing.
 */
export const JUDGE_JSON_SCHEMA: Record<string, unknown> = {
  ...body,
  additionalProperties: false,
  required: [...JUDGE_OUTPUT_KEYS],
}

/**
 * The TOP-LEVEL keys of a JSON document, in the order they were written, read from the
 * raw response text.
 *
 * **Why the raw text and not the parsed object.** Strict-mode enforcement varies by
 * upstream (ADR-0022), and a model that emits `verdict` before `rationale` produces
 * something `judgeOutputSchema.safeParse` accepts without complaint — while silently
 * deleting the deliberation ADR-0019 exists to force. The parsed object cannot answer the
 * question; only the bytes can.
 *
 * It is depth-aware and string-aware, because both are ways to get the wrong answer: a
 * `verdict` key nested inside a value is not the top-level `verdict`, and the characters
 * `"verdict":` appearing inside a rationale the model wrote are not a key at all.
 */
export const topLevelKeyOrder = (json: string): string[] => {
  const keys: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let stringStart = -1
  // The most recently closed string, still eligible to be a key — it becomes one only if
  // the next non-whitespace character is a colon.
  let candidate: string | undefined

  for (let index = 0; index < json.length; index++) {
    const char = json[index]

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        // Only a string closing at the top level can name a top-level key. Anything
        // deeper belongs to a nested object or array and is none of our business.
        candidate = depth === 1 ? json.slice(stringStart + 1, index) : undefined
      }
      continue
    }

    if (char === '"') {
      inString = true
      stringStart = index
      continue
    }
    if (char === '{' || char === '[') {
      depth += 1
      candidate = undefined
      continue
    }
    if (char === '}' || char === ']') {
      depth -= 1
      candidate = undefined
      continue
    }
    if (char === ':') {
      if (depth === 1 && candidate !== undefined) keys.push(candidate)
      candidate = undefined
      continue
    }
    // Whitespace is the only thing allowed between a key and its colon; anything else
    // means the string that just closed was a value, not a key.
    if (char !== ' ' && char !== '\n' && char !== '\t' && char !== '\r') candidate = undefined
  }

  return keys
}

/**
 * Whether the response emitted the contract's four keys, in the contract's order, first.
 *
 * Extra keys AFTER the four are tolerated: a provider that appends its own metadata has
 * not damaged the deliberation ordering, and `additionalProperties: false` plus the
 * contract's own parse are what reject genuinely off-schema answers. What is not
 * tolerated is a different order among the four, or a missing one.
 */
export const hasContractKeyOrder = (json: string): boolean => {
  const keys = topLevelKeyOrder(json)
  return JUDGE_OUTPUT_KEYS.every((key, index) => keys[index] === key)
}
