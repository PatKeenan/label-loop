/**
 * The pure half of the shaped view (ADR-0073): the caller's roles as something to DRAW, with
 * no React in it, so the rules are tested without a DOM.
 *
 * Two message formats are recognised, because they are the two agents actually hold:
 * - OpenAI: `{ role, content }`, `tool_calls: [{ id, function: { name, arguments } }]` on an
 *   assistant message, and `{ role: 'tool', tool_call_id, content }` for each result;
 * - Anthropic: `content` as blocks — `text`, `tool_use { id, name, input }`, and
 *   `tool_result { tool_use_id, content }` inside a user message.
 * Tool calls become STEPS between the turns, each paired with its result by id.
 *
 * The same recognition runs on the server for the judge's prompt (`llm/render-for-model.ts`);
 * the two are kept apart on purpose — one produces text for a model, this produces structure
 * for a person — and each is tested against both formats.
 */

export type Say = { kind: 'say'; speaker: string; text: string }
export type Call = {
  kind: 'call'
  name: string
  args: unknown
  /** `undefined` when no result came back — itself worth seeing. */
  result: unknown
}
/** A tool result whose call is not in the transcript. Kept, never dropped. */
export type Orphan = { kind: 'orphan'; result: unknown }
export type Step = Say | Call | Orphan

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** OpenAI sends arguments (and often results) as JSON STRINGS: show them as data. */
const parseLoose = (value: unknown): unknown => {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** Anthropic's tool_result content as text blocks, flattened to its text. */
const resultValue = (content: unknown): unknown =>
  Array.isArray(content) && content.every((block) => isRecord(block) && 'text' in block)
    ? content.map((block) => String((block as { text: unknown }).text)).join('\n')
    : parseLoose(content)

export const isMessages = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => isRecord(item) && typeof item.role === 'string')

/** A messages array as steps, in time order; `null` when the value is not messages. */
export const toSteps = (value: unknown): Step[] | null => {
  if (!isMessages(value)) return null

  const steps: Step[] = []
  const calls = new Map<string, Call>()
  const call = (id: unknown, name: unknown, args: unknown) => {
    const step: Call = {
      kind: 'call',
      name: typeof name === 'string' ? name : 'tool',
      args: parseLoose(args),
      result: undefined,
    }
    if (typeof id === 'string') calls.set(id, step)
    steps.push(step)
  }
  const result = (id: unknown, content: unknown) => {
    const step = typeof id === 'string' ? calls.get(id) : undefined
    if (step === undefined) steps.push({ kind: 'orphan', result: resultValue(content) })
    else step.result = resultValue(content)
  }

  for (const message of value) {
    const role = message.role as string
    if (role === 'tool') {
      result(message.tool_call_id, message.content)
      continue
    }
    const { content } = message
    if (typeof content === 'string') {
      if (content.trim() !== '') steps.push({ kind: 'say', speaker: role, text: content })
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!isRecord(block)) continue
        if (block.type === 'text' && typeof block.text === 'string') {
          if (block.text.trim() !== '') steps.push({ kind: 'say', speaker: role, text: block.text })
        } else if (block.type === 'tool_use') call(block.id, block.name, block.input)
        else if (block.type === 'tool_result') result(block.tool_use_id, block.content)
      }
    }
    if (Array.isArray(message.tool_calls)) {
      for (const tc of message.tool_calls) {
        if (isRecord(tc)) {
          const fn = isRecord(tc.function) ? tc.function : {}
          call(tc.id, fn.name, fn.arguments)
        }
      }
    }
  }
  return steps
}

/** Neutral speaker names (plan decision 10): an operations ticket is not a "customer". */
export const speakerLabel = (speaker: string): string =>
  speaker === 'user'
    ? 'User'
    : speaker === 'assistant'
      ? 'Agent'
      : speaker === 'system'
        ? 'System'
        : speaker

const isAgentSay = (step: Step): step is Say => step.kind === 'say' && step.speaker === 'assistant'

/**
 * What the view draws.
 *
 * - `conversation` — the input is messages and the output is a reply (a string, or messages):
 *   ONE flow in time order, the output as the conversation's next turn. Only the agent's LAST
 *   reply in the output is judged; any tool calls it made on the way are evidence, drawn like
 *   every other step and never inside the judged turn (ADR-0073). `judged` is that reply's
 *   index in `steps`, or null when the turn ended with no reply — itself something to judge.
 * - `separate` — anything else (a proposal, a record): the input, then the output alone on
 *   the judged surface.
 * - `legacy` — a trace recorded before inputs were captured (ADR-0074): the output judged,
 *   and no input block at all rather than an empty one.
 */
export type Shaped =
  | { kind: 'conversation'; steps: Step[]; judged: number | null }
  | { kind: 'separate'; input: unknown; output: unknown }
  | { kind: 'legacy'; output: unknown }

export const shapeTrace = ({ input, output }: { input: unknown; output: unknown }): Shaped => {
  if (input === null || input === undefined) return { kind: 'legacy', output }

  const inputSteps = toSteps(input)
  const outputSteps: Step[] | null =
    typeof output === 'string'
      ? output.trim() === ''
        ? []
        : [{ kind: 'say', speaker: 'assistant', text: output }]
      : toSteps(output)
  if (inputSteps === null || outputSteps === null) return { kind: 'separate', input, output }

  const last = outputSteps.findLastIndex(isAgentSay)
  return {
    kind: 'conversation',
    steps: [...inputSteps, ...outputSteps],
    judged: last === -1 ? null : inputSteps.length + last,
  }
}
