import { judgeOutputSchema, type ModelPin, modelRefOf } from '@labelloop/contracts'
import { hasContractKeyOrder, JUDGE_JSON_SCHEMA } from './judge-schema.ts'
import {
  type JudgeCall,
  type ModelProvider,
  ProviderError,
  type ProviderResult,
  type TokenUsage,
} from './provider.port.ts'

/**
 * The OpenRouter adapter (ADR-0021) — the first real `ModelProvider`, and a peer of the
 * fake rather than a replacement for it: both implement the same port and both pass the
 * same contract suite beside it.
 *
 * **Plain `fetch`, no SDK** (ADR-0012, ADR-0021). The resilience this codebase is meant to
 * demonstrate — timeout, backoff, breaker, cost accounting — lives in the gateway above,
 * and a client library that hides those would delete the artifact rather than support it.
 *
 * **`fetch` is a parameter** (ADR-0028). That is what lets the shared contract suite run
 * against this adapter offline and deterministically, and it is why every row of the
 * failure table below is testable without a network or a bill. A network test gated on a
 * secret reports green in exactly the environment where it proved least.
 */

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

export type OpenRouterOptions = {
  apiKey: string
  /** Injected so the contract suite runs offline. Defaults to the platform's. */
  fetch?: typeof globalThis.fetch
  baseUrl?: string
}

/** OpenRouter's error envelope. Everything is optional because a failure may be a proxy's. */
type OpenRouterError = {
  error?: {
    code?: number
    message?: string
    metadata?: Record<string, unknown>
  }
}

type OpenRouterResponse = {
  model?: string
  choices?: Array<{
    finish_reason?: string
    message?: { content?: string | null }
    error?: unknown
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    cost?: number
    completion_tokens_details?: { reasoning_tokens?: number }
  }
  openrouter_metadata?: {
    endpoints?: {
      available?: Array<{ model?: string }>
    }
  }
}

/**
 * The routing controls, built from the pin (ADR-0022).
 *
 * `require_parameters` is the whole mechanism: without it the router is free to pick an
 * endpoint that silently ignores `response_format`, which is the nine-endpoint,
 * three-of-them-cannot-do-structured-output problem the pin exists to solve.
 */
const providerRouting = (pin: ModelPin): Record<string, unknown> => ({
  require_parameters: true,
  data_collection: pin.data_collection,
  ...(pin.quantizations === undefined ? {} : { quantizations: pin.quantizations }),
})

/**
 * `enabled: false` rather than an omitted field. Omitting it hands the decision to the
 * provider's default, which is exactly the drift a frozen `jdv_` exists to prevent — and
 * 83 of 396 catalogued models default to reasoning ON (ADR-0022).
 */
const reasoningControl = (pin: ModelPin): Record<string, unknown> =>
  pin.reasoning.effort === 'none' ? { enabled: false } : { effort: pin.reasoning.effort }

/**
 * The prompt envelope, and it is deliberately almost empty.
 *
 * CONVENTIONS: prompts live in versioned judge configs, not in code. The judge's rubric IS
 * `question`, so everything here is framing that belongs to the transport rather than to
 * the judge — say what the inputs are, and let the schema do the rest. Anything more
 * opinionated would be an unversioned prompt fragment that every `jdv_` silently inherits
 * and no version records.
 */
const messages = (call: JudgeCall): Array<{ role: string; content: string }> => {
  const context = Object.entries(call.context ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n')

  return [
    {
      role: 'system',
      content:
        'You judge one artifact against one binary question. Answer only with the ' +
        'required JSON object, giving your reasoning before your verdict.',
    },
    {
      role: 'user',
      content: [
        `Question: ${call.question}`,
        ...(context === '' ? [] : [`Context:\n${context}`]),
        `Artifact:\n${call.artifact}`,
      ].join('\n\n'),
    },
  ]
}

/**
 * A refusal COMPLETED (D7). The provider looked at the request, decided, and answered —
 * which is a rubric problem to see in the console, not an infrastructure failure to retry.
 * A malformed request did not: nobody judged anything, it never self-heals, and it is our
 * bug, which is the three properties that define `misconfigured` (ADR-0024).
 */
const isModeration = (body: OpenRouterError): boolean => {
  const metadata = body.error?.metadata
  if (metadata === undefined) return false
  return 'reasons' in metadata || 'flagged_input' in metadata
}

/** The failure table this adapter exists for. Every row has a test. */
const failureFor = (status: number, body: OpenRouterError): ProviderError => {
  const message = `openrouter responded ${status}`

  // A refusal, and a guardrail block, both COMPLETED. Checked before the 400 rule below,
  // because the metadata is what separates the two readings of the same status code.
  if ((status === 400 || status === 403) && isModeration(body)) {
    return new ProviderError('invalid_output', message, { raw: body })
  }
  // Never self-heals: a rejected key is rejected on the second call too, and a request the
  // provider calls malformed is ours to fix. Retrying is the same answer, billed twice.
  if (status === 400 || status === 401 || status === 402) {
    return new ProviderError('misconfigured', message, { raw: body })
  }
  if (status === 408) {
    return new ProviderError('timeout', message, { raw: body })
  }
  // 404 is an unknown slug, which the contract suite requires as `unavailable`. 503 is
  // both "upstream is down" and "no endpoint matches routing" — call time cannot tell a
  // transient empty pool from a permanently unsatisfiable pin, so it is retried, and
  // creation-time validation (ADR-0026) is the mitigation for the permanent case.
  return new ProviderError('unavailable', message, { raw: body })
}

/**
 * The DATED id of the endpoint that answered — `anthropic/claude-sonnet-5-20260630` where
 * `response.model` says `anthropic/claude-sonnet-5`. The dated snapshot is the identity
 * that actually served the call, and it is the whole of ADR-0022's `served_by` story.
 */
const servedByOf = (body: OpenRouterResponse, requested: string): string => {
  const available = body.openrouter_metadata?.endpoints?.available
  const dated = available?.[0]?.model
  if (typeof dated === 'string' && dated.length > 0) return dated
  if (typeof body.model === 'string' && body.model.length > 0) return body.model
  return requested
}

const usageOf = (body: OpenRouterResponse): TokenUsage => {
  const reasoning = body.usage?.completion_tokens_details?.reasoning_tokens
  return {
    input: body.usage?.prompt_tokens ?? 0,
    output: body.usage?.completion_tokens ?? 0,
    // Absent is not zero: a provider that did not report deliberation has said nothing,
    // and a model that genuinely did none has said something.
    ...(typeof reasoning === 'number' ? { reasoning } : {}),
  }
}

export const createOpenRouterProvider = ({
  apiKey,
  fetch = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
}: OpenRouterOptions): ModelProvider => ({
  name: 'openrouter',

  evaluate: async (call: JudgeCall): Promise<ProviderResult> => {
    // Before anything else: an adapter that answers an already-aborted call has silently
    // unbounded the timeout that aborted it.
    if (call.signal?.aborted === true) {
      throw new ProviderError('timeout', 'the call was aborted before it started')
    }

    const ref = modelRefOf(call.model)
    if (ref === undefined || ref.route !== 'openrouter') {
      // The contract suite's `unknownModel` case. `unavailable` rather than a thrown
      // TypeError, because a `jdv_` naming a route this build lacks is data, not a bug.
      throw new ProviderError('unavailable', `not an openrouter model: ${call.model}`)
    }

    const body = {
      model: ref.nativeId,
      messages: messages(call),
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'judge_output', strict: true, schema: JUDGE_JSON_SCHEMA },
      },
      ...(call.pin === undefined
        ? {}
        : { reasoning: reasoningControl(call.pin), provider: providerRouting(call.pin) }),
    }

    let response: Response
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          // Which endpoint answered is opt-in, and it is the whole of ADR-0022's
          // `served_by` story plus ADR-0026's endpoint count.
          'x-openrouter-metadata': 'enabled',
        },
        body: JSON.stringify(body),
        ...(call.signal === undefined ? {} : { signal: call.signal }),
      })
    } catch (error) {
      // An abort and a dead socket arrive the same way. Both are calls that did not
      // complete, which is the only distinction the port asks us to make.
      const aborted = error instanceof Error && error.name === 'AbortError'
      throw new ProviderError(
        aborted ? 'timeout' : 'unavailable',
        aborted ? 'the call was aborted' : 'the call could not be completed',
        { cause: error },
      )
    }

    const text = await response.text()
    // Parsed defensively: a proxy or a gateway in front of OpenRouter can answer with
    // HTML, and a JSON parse error on an error path would mask the status that explains it.
    const parsed: unknown = (() => {
      try {
        return JSON.parse(text) as unknown
      } catch {
        return {}
      }
    })()

    if (!response.ok) throw failureFor(response.status, parsed as OpenRouterError)

    const payload = parsed as OpenRouterResponse
    const choice = payload.choices?.[0]
    const content = choice?.message?.content

    // A 200 that completed and is unusable. `finish_reason: 'error'` is OpenRouter's way
    // of reporting a mid-generation upstream failure inside a successful envelope.
    if (choice?.finish_reason === 'error' || typeof content !== 'string' || content === '') {
      throw new ProviderError('invalid_output', 'the model returned no usable message', {
        raw: payload,
      })
    }

    // **Order first, on the raw text, before any parse.** Strict-mode enforcement varies
    // by upstream, and a model emitting `verdict` first produces something Zod accepts
    // while silently deleting the deliberation ADR-0019 exists to force.
    if (!hasContractKeyOrder(content)) {
      throw new ProviderError('invalid_output', 'the model answered out of contract order', {
        raw: payload,
      })
    }

    const output = judgeOutputSchema.safeParse(
      (() => {
        try {
          return JSON.parse(content) as unknown
        } catch {
          return undefined
        }
      })(),
    )
    if (!output.success) {
      throw new ProviderError('invalid_output', 'the model answered off-schema', { raw: payload })
    }

    const endpoints = payload.openrouter_metadata?.endpoints?.available
    const cost = payload.usage?.cost

    return {
      output: output.data,
      usage: usageOf(payload),
      servedBy: servedByOf(payload, call.model),
      raw: payload,
      // Verified 1:1 in USD against three models with a real key on 2026-08-29 (ADR-0027).
      ...(typeof cost === 'number' ? { costUsd: cost } : {}),
      ...(Array.isArray(endpoints) ? { availableEndpoints: endpoints.length } : {}),
    }
  },
})
