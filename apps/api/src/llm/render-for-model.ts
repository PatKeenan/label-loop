import type { JsonValue } from '@labelloop/contracts'

/**
 * A role's value as prompt text (ADR-0073) — ONE pure function, shared by every adapter, so
 * the prompt a judge reads is the same whichever provider serves it.
 *
 * Three shapes, checked in this order:
 * - a STRING, verbatim — a chat reply, a bug report;
 * - a MESSAGES array (every element an object with a string `role`) as ordered turns, in
 *   either format an agent already holds: OpenAI (`tool_calls` on an assistant message,
 *   `role: 'tool'` results) or Anthropic (`tool_use` / `tool_result` content blocks). Each
 *   tool call is one line, `→ name(args) ⇒ result`, its result paired to it by id;
 * - anything else as indented JSON — a proposal object, a record.
 *
 * It never throws and never drops content: a message it does not recognise still renders,
 * as JSON, so an unusual shape costs readability rather than evidence.
 */
export const renderForModel = (value: JsonValue): string => {
  if (typeof value === 'string') return value
  if (isMessages(value)) return renderMessages(value)
  return json(value)
}

type JsonObject = { [key: string]: JsonValue }
type Message = JsonObject & { role: string }

const json = (value: JsonValue): string => JSON.stringify(value, null, 2)

const isObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isMessages = (value: JsonValue): value is Message[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isObject(item) && typeof item.role === 'string')

/** Neutral names (plan decision 10): an operations ticket is not a "customer". */
const SPEAKERS: Record<string, string> = { user: 'User', assistant: 'Agent', system: 'System' }

/** A tool call's arguments or result as ONE line — the step is a line, not a block. */
const inline = (value: JsonValue | undefined): string => {
  if (value === undefined) return ''
  if (typeof value === 'string') {
    // OpenAI sends arguments as a JSON STRING; unwrap it so it reads as data, not as quotes.
    try {
      return inline(JSON.parse(value) as JsonValue)
    } catch {
      return value.replaceAll('\n', ' ')
    }
  }
  if (Array.isArray(value) && value.every((block) => isObject(block) && 'text' in block)) {
    // Anthropic's tool_result content as text blocks.
    return value.map((block) => (isObject(block) ? String(block.text) : '')).join(' ')
  }
  return JSON.stringify(value)
}

const renderMessages = (messages: Message[]): string => {
  // Pair results to calls by id first, so a call and its result render as one step.
  const results = new Map<string, JsonValue>()
  for (const message of messages) {
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      results.set(message.tool_call_id, message.content ?? null)
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (
        isObject(block) &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        results.set(block.tool_use_id, block.content ?? null)
      }
    }
  }

  const paired = new Set<string>()
  const step = (id: JsonValue | undefined, name: JsonValue | undefined, args: JsonValue) => {
    const result = typeof id === 'string' ? results.get(id) : undefined
    if (typeof id === 'string' && result !== undefined) paired.add(id)
    const call = `→ ${typeof name === 'string' ? name : 'tool'}(${inline(args)})`
    return result === undefined ? call : `${call} ⇒ ${inline(result)}`
  }

  const blocks: string[] = []
  for (const message of messages) {
    const lines: string[] = []
    const { content } = message

    if (typeof content === 'string') lines.push(content)
    for (const part of Array.isArray(content) ? content : []) {
      if (!isObject(part)) continue
      if (part.type === 'text' && typeof part.text === 'string') lines.push(part.text)
      else if (part.type === 'tool_use') lines.push(step(part.id, part.name, part.input ?? null))
      else if (part.type === 'tool_result') {
        // Rendered with its call; only an ORPHAN result needs a line of its own.
        if (typeof part.tool_use_id !== 'string' || !paired.has(part.tool_use_id)) {
          lines.push(`⇒ ${inline(part.content)}`)
        }
      } else lines.push(json(part))
    }
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      if (!isObject(call)) continue
      const fn = isObject(call.function) ? call.function : {}
      lines.push(step(call.id, fn.name, fn.arguments ?? null))
    }

    if (message.role === 'tool') {
      if (typeof message.tool_call_id === 'string' && paired.has(message.tool_call_id)) continue
      blocks.push(`⇒ ${inline(content)}`)
      continue
    }
    if (lines.length === 0) continue
    const speaker = SPEAKERS[message.role] ?? message.role
    blocks.push(`${speaker}: ${lines.join('\n')}`)
  }
  return blocks.join('\n\n')
}
