import { describe, expect, test } from 'bun:test'
import { judgeOutputSchema, RATIONALE_MAX_LENGTH } from '@labelloop/contracts'
import {
  hasContractKeyOrder,
  JUDGE_JSON_SCHEMA,
  JUDGE_OUTPUT_KEYS,
  topLevelKeyOrder,
} from './judge-schema.ts'

/**
 * Two claims, and the second is the one that earns its keep: the wire schema cannot drift
 * from the contract because it is derived from it, and a response that satisfies the
 * contract can still be wrong — because Zod does not see order, and order is what makes a
 * rationale a deliberation rather than a rationalisation.
 */

describe('the derived wire schema', () => {
  test('carries exactly the contract’s four properties, in the contract’s order', () => {
    const properties = JUDGE_JSON_SCHEMA.properties as Record<string, unknown>
    // Not `toEqual` on a set: the ORDER of this array is what the provider generates in.
    expect(Object.keys(properties)).toEqual([...JUDGE_OUTPUT_KEYS])
  })

  test('requires all four — an optional field is one the model may decline to emit', () => {
    expect(JUDGE_JSON_SCHEMA.required).toEqual([...JUDGE_OUTPUT_KEYS])
  })

  test('forbids additional properties, so `strict` has something to be strict about', () => {
    expect(JUDGE_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(JUDGE_JSON_SCHEMA.type).toBe('object')
  })

  test('is fully inlined: no $ref, no $defs, and no dialect declaration', () => {
    const serialized = JSON.stringify(JUDGE_JSON_SCHEMA)
    expect(serialized).not.toContain('$ref')
    expect(serialized).not.toContain('$defs')
    expect(serialized).not.toContain('$schema')
  })

  test('keeps the constraints that bound the answer, not just its shape', () => {
    const properties = JUDGE_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>
    // Asserted against the CONSTANT, never a literal. A literal here is what let the wire
    // schema and the parser drift apart in the first place — and the wire half is advisory
    // anyway, since providers constrain shape rather than string length. It is still sent:
    // a provider that ever does honour it costs us nothing, and the parser is the one that
    // actually decides.
    expect(properties.rationale?.maxLength).toBe(RATIONALE_MAX_LENGTH)
    expect(properties.confidence?.minimum).toBe(0)
    expect(properties.confidence?.maximum).toBe(1)
    expect(properties.verdict?.type).toBe('boolean')
  })

  test('survives JSON round-tripping with its order intact — that is what is sent', () => {
    const roundTripped = JSON.parse(JSON.stringify(JUDGE_JSON_SCHEMA)) as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(roundTripped.properties)).toEqual([...JUDGE_OUTPUT_KEYS])
  })
})

describe('reading key order off the raw text', () => {
  test('reports the top-level keys in the order they were written', () => {
    expect(
      topLevelKeyOrder('{"rationale":"a","reasons":[],"verdict":true,"confidence":0.9}'),
    ).toEqual([...JUDGE_OUTPUT_KEYS])
  })

  test('ignores keys nested inside a value — depth is the whole point', () => {
    const json = '{"rationale":"a","meta":{"verdict":false,"rationale":"b"},"verdict":true}'
    expect(topLevelKeyOrder(json)).toEqual(['rationale', 'meta', 'verdict'])
  })

  test('ignores anything inside `reasons`, which is where nesting actually shows up', () => {
    const json = '{"rationale":"a","reasons":["verdict","confidence"],"verdict":true}'
    expect(topLevelKeyOrder(json)).toEqual(['rationale', 'reasons', 'verdict'])
  })

  test('ignores key-shaped text inside a string literal the model wrote', () => {
    // A rationale is prose written by a model, so it can contain anything at all —
    // including something that looks exactly like the JSON around it.
    const json =
      '{"rationale":"the report says \\"verdict\\": true, which is wrong","verdict":true}'
    expect(topLevelKeyOrder(json)).toEqual(['rationale', 'verdict'])
  })

  test('is unbothered by whitespace, including a pretty-printed response', () => {
    const json = '{\n  "rationale" : "a",\n  "verdict"\n  : true\n}'
    expect(topLevelKeyOrder(json)).toEqual(['rationale', 'verdict'])
  })

  test('does not mistake a string VALUE for the key that follows it', () => {
    expect(topLevelKeyOrder('{"rationale":"reasons","verdict":true}')).toEqual([
      'rationale',
      'verdict',
    ])
  })

  test('an escaped backslash at the end of a value does not swallow the closing quote', () => {
    expect(topLevelKeyOrder('{"rationale":"ends with a backslash \\\\","verdict":true}')).toEqual([
      'rationale',
      'verdict',
    ])
  })
})

describe('the order check the adapter actually calls', () => {
  const inOrder = '{"rationale":"a","reasons":[],"verdict":true,"confidence":0.9}'

  test('accepts the contract’s order', () => {
    expect(hasContractKeyOrder(inOrder)).toBe(true)
  })

  test('rejects a verdict emitted first — even though Zod accepts the parsed object', () => {
    const verdictFirst = '{"verdict":true,"rationale":"a","reasons":[],"confidence":0.9}'
    // Both halves of the claim, in one test, because the second is why the first exists:
    // the contract cannot see this, so something else has to.
    expect(judgeOutputSchema.safeParse(JSON.parse(verdictFirst)).success).toBe(true)
    expect(hasContractKeyOrder(verdictFirst)).toBe(false)
  })

  test('rejects a response missing one of the four', () => {
    expect(hasContractKeyOrder('{"rationale":"a","reasons":[],"verdict":true}')).toBe(false)
  })

  test('tolerates provider metadata appended after the four', () => {
    expect(hasContractKeyOrder(`${inOrder.slice(0, -1)},"_meta":{"cached":false}}`)).toBe(true)
  })
})
