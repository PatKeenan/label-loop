import { describe, expect, test } from 'bun:test'
import { renderForModel } from './render-for-model.ts'

describe('renderForModel — a role as prompt text, by shape (ADR-0073)', () => {
  test('a string is verbatim, even one that looks like JSON', () => {
    expect(renderForModel('I refunded the duplicate charge.')).toBe(
      'I refunded the duplicate charge.',
    )
    expect(renderForModel('{"not":"parsed"}')).toBe('{"not":"parsed"}')
  })

  test('an object — a proposal, a record — is indented JSON', () => {
    expect(renderForModel({ action: 'refund', amount: 49 })).toBe(
      '{\n  "action": "refund",\n  "amount": 49\n}',
    )
  })

  test('an array that is not messages is JSON, not a transcript', () => {
    expect(renderForModel([1, 2])).toBe('[\n  1,\n  2\n]')
    expect(renderForModel([])).toBe('[]')
    expect(renderForModel([{ role: 'user' }, { no_role: true }])).toContain('"no_role"')
  })

  test('messages are ordered turns with neutral speakers', () => {
    expect(
      renderForModel([
        { role: 'system', content: 'You are support.' },
        { role: 'user', content: 'Was I charged twice?' },
        { role: 'assistant', content: 'Let me look.' },
      ]),
    ).toBe('System: You are support.\n\nUser: Was I charged twice?\n\nAgent: Let me look.')
  })

  test('OpenAI tool calls are steps, each paired with its result by id', () => {
    expect(
      renderForModel([
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
      ]),
    ).toBe(
      'User: Was I charged twice?\n\n' +
        'Agent: → list_charges({"month":"2026-03"}) ⇒ [{"amount":49},{"amount":49}]',
    )
  })

  test('Anthropic tool_use / tool_result blocks render the same way', () => {
    expect(
      renderForModel([
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
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: [{ type: 'text', text: '2' }] },
          ],
        },
      ]),
    ).toBe(
      'User: Was I charged twice?\n\n' +
        'Agent: Checking.\n→ list_charges({"month":"2026-03"}) ⇒ 2',
    )
  })

  test('an unpaired call stands alone, and an orphan result is not dropped', () => {
    const text = renderForModel([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'a', function: { name: 'lookup', arguments: 'not json' } }],
      },
      { role: 'tool', tool_call_id: 'zzz', content: 'orphaned' },
    ])
    expect(text).toBe('Agent: → lookup(not json)\n\n⇒ orphaned')
  })
})
