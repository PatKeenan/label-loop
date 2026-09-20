import { describe, expect, test } from 'bun:test'
import { shapeTrace, speakerLabel, toSteps } from './to-steps.ts'

const OPENAI = [
  { role: 'user', content: 'Was I charged twice?' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'list_charges', arguments: '{"month":"2026-03"}' },
      },
    ],
  },
  { role: 'tool', tool_call_id: 'call_1', content: '[{"amount":49},{"amount":49}]' },
]

const ANTHROPIC = [
  { role: 'user', content: 'Was I charged twice?' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'tu_1', name: 'list_charges', input: { month: '2026-03' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '2' }] }],
  },
]

describe('toSteps — messages as steps in time order', () => {
  test('OpenAI: a tool call is one step, paired with its result by id', () => {
    expect(toSteps(OPENAI)).toEqual([
      { kind: 'say', speaker: 'user', text: 'Was I charged twice?' },
      {
        kind: 'call',
        name: 'list_charges',
        args: { month: '2026-03' },
        result: [{ amount: 49 }, { amount: 49 }],
      },
    ])
  })

  test('Anthropic: tool_use / tool_result blocks become the same steps', () => {
    expect(toSteps(ANTHROPIC)).toEqual([
      { kind: 'say', speaker: 'user', text: 'Was I charged twice?' },
      { kind: 'say', speaker: 'assistant', text: 'Checking.' },
      { kind: 'call', name: 'list_charges', args: { month: '2026-03' }, result: '2' },
    ])
  })

  test('an unpaired call has no result; an orphan result is kept, not dropped', () => {
    expect(
      toSteps([
        { role: 'assistant', content: null, tool_calls: [{ id: 'a', function: { name: 'f' } }] },
        { role: 'tool', tool_call_id: 'nope', content: 'lost' },
      ]),
    ).toEqual([
      { kind: 'call', name: 'f', args: undefined, result: undefined },
      { kind: 'orphan', result: 'lost' },
    ])
  })

  test('anything that is not messages is null', () => {
    for (const value of ['text', { a: 1 }, [], [1, 2], [{ role: 'user' }, { no: 'role' }], null]) {
      expect(toSteps(value)).toBeNull()
    }
  })

  test('speakers are neutral: User and Agent, never "Customer"', () => {
    expect(speakerLabel('user')).toBe('User')
    expect(speakerLabel('assistant')).toBe('Agent')
    expect(speakerLabel('system')).toBe('System')
  })
})

describe('shapeTrace — what is drawn, and which one thing is judged', () => {
  test('a chat reply is the conversation’s next turn, and the judged one', () => {
    const shaped = shapeTrace({ input: [{ role: 'user', content: 'hi' }], output: 'hello' })
    expect(shaped).toEqual({
      kind: 'conversation',
      steps: [
        { kind: 'say', speaker: 'user', text: 'hi' },
        { kind: 'say', speaker: 'assistant', text: 'hello' },
      ],
      judged: 1,
    })
  })

  test('the LAST reply is judged; the tool calls before it are evidence', () => {
    const shaped = shapeTrace({
      input: [{ role: 'user', content: 'Was I charged twice?' }],
      output: [...OPENAI.slice(1), { role: 'assistant', content: 'Yes — refunded one.' }],
    })
    if (shaped.kind !== 'conversation') throw new Error(shaped.kind)
    expect(shaped.steps.map((step) => step.kind)).toEqual(['say', 'call', 'say'])
    expect(shaped.judged).toBe(2)
  })

  test('an earlier agent turn in the INPUT is never the judged one', () => {
    const shaped = shapeTrace({
      input: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
      output: 'd',
    })
    expect(shaped.kind === 'conversation' && shaped.judged).toBe(3)
  })

  test('a turn with calls and no reply judges nothing — and says so', () => {
    const shaped = shapeTrace({ input: [{ role: 'user', content: 'x' }], output: OPENAI.slice(1) })
    expect(shaped.kind === 'conversation' && shaped.judged).toBeNull()
  })

  test('a proposal is separate: the input, then the output alone', () => {
    const output = { action: 'refund', amount: 49 }
    expect(shapeTrace({ input: OPENAI, output })).toEqual({
      kind: 'separate',
      input: OPENAI,
      output,
    })
    expect(shapeTrace({ input: 'an issue', output: 'P2' }).kind).toBe('separate')
  })

  test('a legacy trace — no input recorded — is legacy, never an empty input', () => {
    expect(shapeTrace({ input: null, output: 'P2' })).toEqual({ kind: 'legacy', output: 'P2' })
  })
})
