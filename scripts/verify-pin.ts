#!/usr/bin/env bun
import { CAPABILITY_STRUCTURED_OUTPUTS, type ModelPin, modelPinSchema } from '@labelloop/contracts'
import { topLevelKeyOrder } from '../apps/api/src/llm/judge-schema.ts'
import { createOpenRouterProvider } from '../apps/api/src/llm/openrouter-provider.ts'
import { isProviderError } from '../apps/api/src/llm/provider.port.ts'
import { requireEnv } from './env.ts'

/**
 * One real judge call against one real model, printed.
 *
 * **A script, deliberately, and never a test** (ADR-0028). This costs money and needs a
 * secret, and a test that quietly passes when neither is present reports a green suite
 * that proved nothing — the same defect as a database test that skips without a database,
 * which CI already refuses. The live path is exercised by a human who meant to.
 *
 * It answers the three things nothing static can (ADR-0022): whether the pin routes at
 * all, how many endpoints survive it, and whether the model honours the schema **in the
 * required key order** — the last being the one a passing parse cannot tell you.
 *
 *   bun run verify:pin openrouter:anthropic/claude-sonnet-5
 *   bun run verify:pin openrouter:google/gemini-3.7-flash medium
 *
 * The same `validatePin` mechanism runs at judge creation (P4) and in the seed (P5), so
 * this is one mechanism exercised by hand, not a second one written for people.
 */

const [model, effort = 'none'] = process.argv.slice(2)

if (model === undefined) {
  console.error('usage: bun run verify:pin <route:model-id> [none|low|medium|high]')
  process.exit(1)
}

const apiKey = requireEnv('OPENROUTER_API_KEY')

const pin: ModelPin = modelPinSchema.parse({
  capabilities: [CAPABILITY_STRUCTURED_OUTPUTS],
  data_collection: 'deny',
  reasoning: { effort },
})

/**
 * A fixed probe, sized like a real judge call rather than like a smoke test: ADR-0023's
 * cost estimate assumes roughly 2,000 input tokens, and the per-attempt timeout this
 * script exists to re-derive (Decision 14) is only meaningful against an artifact of that
 * shape. Latency on a 20-token artifact would tell us nothing about the number to pick.
 */
const ARTIFACT = `${'Login button does nothing on Safari 17. Steps: open the app, sign in, click the primary button in the header. Nothing happens and no network request is issued. This reproduces on two machines. '.repeat(40)}`

const provider = createOpenRouterProvider({ apiKey })

const startedAt = performance.now()

try {
  const result = await provider.evaluate({
    model,
    question: 'Does this report describe something behaving incorrectly?',
    artifact: ARTIFACT,
    pin,
  })
  const latencyMs = Math.round(performance.now() - startedAt)
  const content = JSON.stringify(result.output)

  console.log(`model            ${model}`)
  console.log(`effort           ${pin.reasoning.effort}`)
  console.log(`served_by        ${result.servedBy}`)
  console.log(`endpoints        ${result.availableEndpoints ?? 'not reported'}`)
  console.log(`key order        ${topLevelKeyOrder(content).join(' → ')}`)
  console.log(`tokens in/out    ${result.usage.input} / ${result.usage.output}`)
  console.log(`reasoning tokens ${result.usage.reasoning ?? 'not reported'}`)
  console.log(`cost usd         ${result.costUsd ?? 'not reported'}`)
  // The number Decision 14 says must be MEASURED rather than inherited: 10s was chosen
  // against a fake, and M2's k6 baseline inherits whatever this phase writes down.
  console.log(`latency ms       ${latencyMs}`)
  console.log(`verdict          ${String(result.output.verdict)} @ ${result.output.confidence}`)
} catch (error) {
  const latencyMs = Math.round(performance.now() - startedAt)
  if (isProviderError(error)) {
    // A named failure, not a stack trace. An unsatisfiable pin is a form error at M4, and
    // this is the same information in a terminal.
    console.error(`FAILED           ${error.kind} after ${latencyMs}ms`)
    console.error(`                 ${error.message}`)
    if (error.raw !== undefined) console.error(JSON.stringify(error.raw, null, 2))
    process.exit(1)
  }
  throw error
}
