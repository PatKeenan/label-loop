import { judgeOutputSchema, type ModelPin, modelRefOf } from '@labelloop/contracts'
import { type ChatResult, chatResultFromJSON } from '@openrouter/sdk/models'
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
 * **Our transport, their types** (ADR-0030). The request goes out on plain `fetch` and every
 * resilience primitive stays in the gateway above (ADR-0012) — OpenRouter's own client
 * retries on 5XX for up to an HOUR of elapsed time, with jitter added on top of a
 * deterministic base rather than full jitter, and a `Math.random()` nothing can inject; it
 * has no circuit breaker at all. Adopting it would replace a better policy with a worse one
 * and hide the work this project exists to show.
 *
 * What it does own better than we can is the SHAPE of what comes back, so the response is
 * parsed with the SDK's own `chatResultFromJSON`. Hand-written response types were the
 * brittle half of this file: every field optional, drift invisible to typecheck, and a
 * silently-`undefined` read the first time OpenRouter moved something.
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
 * `result.model` says `anthropic/claude-sonnet-5`. The dated snapshot is the identity that
 * actually served the call, and it is the whole of ADR-0022's `served_by` story.
 *
 * **`selected`, not the first entry.** `available` is the whole pool that survived the pin
 * — five of nine for Sonnet 5 on 2026-08-29 — and exactly one of them answered. Reading
 * position zero would name a real endpoint that did not serve this call, which is worse
 * than naming none: it is a plausible wrong answer in the field a routing-drift query
 * depends on. The SDK's `EndpointInfo.selected` is what makes the distinction visible.
 */
const servedByOf = (result: ChatResult, requested: string): string => {
  const selected = result.openrouterMetadata?.endpoints.available.find((e) => e.selected)?.model
  if (selected !== undefined && selected.length > 0) return selected
  if (result.model.length > 0) return result.model
  return requested
}

const usageOf = (result: ChatResult): TokenUsage => {
  const reasoning = result.usage?.completionTokensDetails?.reasoningTokens
  return {
    input: result.usage?.promptTokens ?? 0,
    output: result.usage?.completionTokens ?? 0,
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

    // Parsed by the SDK's own schema rather than by hand-written optional types. Unknown
    // fields are STRIPPED, not rejected, so a field OpenRouter adds tomorrow cannot break a
    // good call — verified against the shipped schema. What it does reject is a field it
    // declares required going missing, which is `invalid_output`: the call completed and
    // what came back is not something we can read. Never a crash, and `raw` keeps the
    // payload so the diagnosis survives.
    const decoded = chatResultFromJSON(text)
    if (!decoded.ok) {
      throw new ProviderError('invalid_output', 'the response did not match the provider schema', {
        raw: parsed,
        cause: decoded.error,
      })
    }
    const payload = decoded.value
    const choice = payload.choices[0]
    const content = choice?.message?.content

    // A 200 that completed and is unusable. `finish_reason: 'error'` is OpenRouter's way
    // of reporting a mid-generation upstream failure inside a successful envelope.
    if (choice?.finishReason === 'error' || typeof content !== 'string' || content === '') {
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

    // The pool that survived the pin, which is the number ADR-0026 records at creation —
    // NOT `endpoints.total`, which counts the catalogue before the pin narrowed it.
    const available = payload.openrouterMetadata?.endpoints.available
    const cost = payload.usage?.cost

    return {
      output: output.data,
      usage: usageOf(payload),
      servedBy: servedByOf(payload, call.model),
      raw: payload,
      // Verified 1:1 in USD against three models with a real key on 2026-08-29 (ADR-0027).
      ...(typeof cost === 'number' ? { costUsd: cost } : {}),
      ...(available === undefined ? {} : { availableEndpoints: available.length }),
    }
  },
})
