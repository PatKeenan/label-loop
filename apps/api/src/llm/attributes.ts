/**
 * Span attribute names for model calls.
 *
 * The `gen_ai.*` names are OpenTelemetry's semantic convention for generative-AI clients.
 * They are spelled out here rather than imported from `@opentelemetry/semantic-conventions`
 * because that package exports them only from its `/incubating` entry point, whose whole
 * contract is that the names may change under us. A dozen string constants in one file is
 * a cheaper thing to update than an unstable import fanned out across the gateway — and it
 * makes the boundary between "the industry's name for this" and "ours" visible.
 *
 * Anything genuinely ours is namespaced `labelloop.*`, so it can never collide with a
 * convention that arrives later.
 */

/** Which provider served the call — `fake` at M0, a real vendor from M1. */
export const ATTR_GEN_AI_SYSTEM = 'gen_ai.system'
/** The model we ASKED for, which is the one pinned in the judge version. */
export const ATTR_GEN_AI_REQUEST_MODEL = 'gen_ai.request.model'
/** The model that actually answered. The two differ when a provider aliases or routes. */
export const ATTR_GEN_AI_RESPONSE_MODEL = 'gen_ai.response.model'
export const ATTR_GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens'
export const ATTR_GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens'

/**
 * What the call cost, in USD. No convention names this, and it is the number M2's metering
 * and M7's model-swap argument are both made of — cost per judge is the whole reason
 * `trace_verdicts` decomposes per judge (P3), so the span decomposes the same way.
 */
export const ATTR_COST_USD = 'labelloop.cost_usd'
/**
 * Whether `cost_usd` is a real figure or a placeholder for a model with no price on file.
 * Without it a zero is ambiguous — M0's fake model genuinely costs nothing, and an
 * unpriced model also reports nothing — and the two must not be summed as if they were the
 * same claim when M2 turns these spans into an invoice.
 */
export const ATTR_COST_PRICED = 'labelloop.cost_priced'
/**
 * Billed deliberation the provider reported. `labelloop.`-namespaced because no OTel
 * convention names it — `gen_ai.usage.*` covers input and output only — and this file's
 * stated rule is that ours are namespaced so a later convention cannot collide.
 *
 * Worth a span attribute of its own rather than folding into output tokens: it is the part
 * of a bill nobody can read back. Measured 2026-08-30, one model's own effort dial moved it
 * 0 → 269 tokens and its cost 1.8x, with nothing else about the request changing.
 */
export const ATTR_REASONING_TOKENS = 'labelloop.reasoning_tokens'
/** How many times the provider was actually called. A success after two retries is not a
 * healthy call, and a span that only records the outcome would say it was. */
export const ATTR_ATTEMPTS = 'labelloop.attempts'
/** The judge this call answers for, by slug — the readable half of "which judge is slow". */
export const ATTR_JUDGE_SLUG = 'labelloop.judge_slug'
/** Which immutable `jdv_` produced the prompt, so a regression points at a version. */
export const ATTR_JUDGE_VERSION_ID = 'labelloop.judge_version_id'
/** `evaluated` / `failed` / `error` — the gateway's own outcome, not the HTTP status. */
export const ATTR_OUTCOME = 'labelloop.outcome'
/** The taxonomy code, when the outcome was an error. Branchable in a Tempo query. */
export const ATTR_ERROR_CODE = 'labelloop.error_code'
/** Why an attempt failed: `timeout`, `unavailable`, `invalid_output`, `circuit_open`. */
export const ATTR_FAILURE_KIND = 'labelloop.failure_kind'
/** How long the retry loop slept before the next attempt. Makes backoff visible as data. */
export const ATTR_BACKOFF_MS = 'labelloop.backoff_ms'

/**
 * Metric names for model calls, beside the span attribute names and under the same rule:
 * an industry convention keeps its own name, anything of ours is namespaced `labelloop.*`.
 *
 * `gen_ai.client.operation.duration` is the convention's own name for exactly this
 * measurement, so it is used. The token counters are NOT `gen_ai.client.token.usage`,
 * deliberately — that convention is a histogram of per-call usage, and what a cost
 * dashboard needs is a monotonic total. Borrowing the name for different semantics would
 * be worse than not using it, because the name is what tells a reader which one they have.
 */
export const METRIC_JUDGE_DURATION = 'gen_ai.client.operation.duration'
export const METRIC_JUDGE_CALLS = 'labelloop.judge.calls'
export const METRIC_JUDGE_INPUT_TOKENS = 'labelloop.judge.tokens.input'
export const METRIC_JUDGE_OUTPUT_TOKENS = 'labelloop.judge.tokens.output'
export const METRIC_JUDGE_REASONING_TOKENS = 'labelloop.judge.tokens.reasoning'
/**
 * Spend, carrying `labelloop.cost_priced` as a label so the two are never summed together.
 * A single total folds a genuinely-free fake call and an unpriced model's missing figure
 * into real money and reports less than was spent.
 */
export const METRIC_JUDGE_COST_USD = 'labelloop.judge.cost_usd'
export const METRIC_JUDGE_ATTEMPTS = 'labelloop.judge.attempts'
/**
 * `0` closed, `1` half-open, `2` open — an observable gauge, read from the registry at
 * collection time rather than pushed on state change, so a breaker that has been open for
 * an hour still reports open on every scrape instead of once.
 */
export const METRIC_JUDGE_BREAKER_STATE = 'labelloop.judge.breaker_state'
