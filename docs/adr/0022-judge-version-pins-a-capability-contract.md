# ADR-0022: A frozen judge version pins a capability contract, not a model name

**Status:** Accepted · **Date:** 2026-08-29

## Decision
`judge_versions` identifies the model behind an `llm` judge with **two immutable columns**:

- `model` — a route-qualified string, `<route>:<path-native-id>`
  (`openrouter:anthropic/claude-sonnet-5`, `fake:deterministic`, later `finetune:acme-tone-v3`).
  The prefix names the access path and is what the adapter registry dispatches on.
- `model_pin` — jsonb, carrying the **properties an endpoint must have** to serve this judge:
  the required capabilities, the data-collection stance (ADR-0023), the acceptable
  quantizations, and the reasoning effort. It does not name an endpoint.

The pin is translated into the provider request's routing controls on every call, and it is
**validated by one real call before the row is written**. Which endpoint actually answered is
recorded per call in `trace_verdicts.served_by`, read from the provider's routing metadata.

This closes the question ADR-0021 explicitly routed to M1 research and required to be answered
before M1 wrote a migration, because the column is public contract frozen by ADR-0003.

## Context
ADR-0021 recorded, as a trap for whoever revisited it, that **the same model is not the same
capability surface across access paths**. Measured against the live catalogue on 2026-08-28,
that is not a theoretical concern:

- `anthropic/claude-sonnet-5` exposes **nine** endpoints. **Three of them — all Google Vertex
  regions — do not support structured output at all.** The model-level `supported_parameters`
  field advertises it anyway, because that field is a UNION across endpoints.
- `openai/gpt-5.6-sol`: seven endpoints, one failing. `google/gemini-3.7-flash`: six, all passing.

A judge frozen to a bare model name therefore has its actual capability decided by routing at
call time — which is neither frozen nor ours. Judge output is a parsed structured contract, so
the failure mode is not a degraded answer but an unusable one, and ADR-0019's deliberate field
ordering (reasoning before verdict) is only enforced where the schema is actually honoured.

**Provider-side reasoning is the same defect again, and the sharpest case.** The models API
exposes `reasoning: {mandatory, default_enabled, supported_efforts, default_effort}`, and **83 of
396 models have `mandatory: true`**. All three seed models carry `default_enabled: true` with
*differing* default efforts — "high" for Sonnet 5, "medium" for gpt-5.6-sol — so silence means
each judge deliberates by a different, unrecorded amount. Worse than the cost: **hidden reasoning
defeats ADR-0019's field ordering.** That ordering exists because these models are autoregressive,
so a verdict emitted before its reasoning makes the reasoning post-hoc. If the model deliberates
privately and *then* emits rationale → reasons → verdict, the verdict was already settled during
the invisible part, and `rationale` becomes precisely the rationalisation the ordering was meant
to prevent — deliberation we are billed for, cannot store, cannot show an annotator, and cannot
correct. (`exclude: true` is strictly worse than either alternative: the model reasons, we pay,
and we see nothing.) Effort is therefore pinned and defaults to `none` where the model permits.
Whether reasoning makes a judge *better* is deliberately not asserted here — it is empirical, and
M6 can answer it as an A/B between two judge versions.

**Quantization is the same defect, quieter.** `z-ai/glm-5.3` is served at fp4, fp8 and bf16
across sixteen hosts at overlapping prices. M6 measures judge-versus-human agreement *per
immutable version*; an unexplained swing between two runs of a frozen version would send
someone hunting for model drift that was in fact a routing change. Precision belongs in the pin
for the same reason capability does.

### Alternatives considered

**A bare model id.** Simplest, and matches the provider's own vocabulary. Rejected because it
cannot distinguish this row from the same model reached through the direct first-party adapter
that ADR-0021's expiry condition commits us to building — at which point "re-run this judge" has
no defined meaning.

**The endpoint encoded into the model string** (`…@amazon-bedrock`). Self-describing in one
column, and an ad-hoc grammar: adding a second constraint means changing the grammar, which
ADR-0003 forbids doing to rows already written.

**A hard endpoint pin.** The obvious fix, and rejected because it buys reproducibility by
destroying availability: a judge pinned to one upstream inherits that upstream's uptime even
when an equivalent endpoint is serving the identical model. The capability contract gets both —
it guarantees the property the judge needs while permitting failover among endpoints that have it.

## Consequences
- One migration adds `model_pin` with the mirror of the existing model/type CHECK: a `code`
  judge calls nothing, so its pin must be NULL.
- **The breaker key stays the model string, not model+pin.** Judges sharing a model share
  upstream capacity, and the provider's internal failover is invisible to us, so the circuit
  should trip only when the whole permitted pool is gone.
- **Creation-time validation is a consequence of immutability, not an extra feature.** It proves
  the pin is satisfiable — an empty routing pool is a 503, and no catalogue field predicts it —
  and that the model honours the schema in the required key order. Creation is the last moment
  the pin can still change, so a permanently broken judge becomes a form error. **It must also
  record how many endpoints survived the pin**: measured on 2026-08-29, `anthropic/claude-sonnet-5`
  had 5 of 9 available and `openai/gpt-5.6-sol` had **1 of 5** — a judge with no failover is
  fragile in a way one with four spares is not, and that is knowable only here.
- **`served_by` records the DATED model id**, not the alias. `openrouter_metadata` returns
  `anthropic/claude-sonnet-5-20260630` where `response.model` returns `anthropic/claude-sonnet-5`;
  the dated snapshot is the identity that actually answered.
- **`reasoning.mandatory` is a picker gate at M4** — unlike data policy it is queryable, so the
  warning can be honest: this model always reasons, and its deliberation cannot be pinned or
  stored. `reasoning_tokens` is stored on `trace_verdicts` regardless, so cost stays explicable.
- **Key order must be asserted on the raw response text, not the parsed object.** Strict-mode
  enforcement varies by upstream; a provider emitting `verdict` before `rationale` produces
  something Zod accepts and which silently deletes the deliberation ADR-0019 exists to force.
  Out of order is `invalid_output`.
- `served_by` becomes meaningful for the first time, and makes routing drift a query rather than
  an assumption.
- The pin cannot be gated in a picker on every axis: **no data-policy field exists on the
  endpoints or providers API**, so that constraint is enforceable only at request time.

**Validated against the live API on 2026-08-29** with three real judge calls: key order was
correct on all three seed models, and `usage.cost` proved to be denominated exactly 1:1 in USD.

Log: `thoughts/shared/progress/decisions-log.md` (2026-08-29)
