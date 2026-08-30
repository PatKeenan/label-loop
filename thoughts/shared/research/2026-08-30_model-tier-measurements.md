---
date: 2026-08-30T00:00:00Z
author: claude-code
status: measured
milestone: M1 (measured) → M4 (consumed)
topic: model-tier-measurements
related_adrs: [0019, 0021, 0022, 0023, 0025]
---

# Cheap tier vs frontier tier — measured against the live API

## Why this exists
The stakeholder asked what a good cheap-tier comparison would be — Haiku, and whatever the
OpenAI and Google equivalents are — and answered the scope question with: **"in the real
app, these should be offered as additional model options to choose from."**

That is M4's line, which already exists in `docs/BUILD_SPINE.md`: *"the judge wizard
includes a capability-gated model picker — the catalogue client and per-endpoint gating are
deferred here from M1 (ADR-0021)."* So nothing here changes M1's scope. This document is
the evidence M4 should be built against, recorded now because it was measured now and
because commit messages are a poor place to keep a table.

All figures: `bun run verify:pin`, real key, one fixed ~2,700-input-token artifact,
2026-08-30. Single samples except where noted.

## The measurements

| Model | Effort | $/M in→out | Latency | Endpoints | Cost/call | Reasoning tokens | Result |
|---|---|---|---|---|---|---|---|
| `anthropic/claude-sonnet-5` | none | 2.00 / 10.00 | 3829 / 4092 / 5304 ms | 5 | $0.007244 | 0 | ok |
| `openai/gpt-5.6-sol` | none | 2.00 / 10.00 | 1877 ms | 3 | $0.005366 | 0 | ok |
| `google/gemini-3.7-flash` | medium | 0.75 / 3.75 | 2337 ms | 2 | $0.002115 | 84 | ok |
| `anthropic/claude-haiku-4.5` | none | 1.00 / 5.00 | 3078 / 5839 / **15092** ms | — | — | 0 | **fails 4/4** |
| `openai/gpt-5.4-mini` | none | 0.75 / 4.50 | 1434 ms | 3 | $0.001753 | 0 | ok |
| `google/gemini-3.7-flash` | low | 0.75 / 3.75 | 3173 ms | 2 | $0.002186 | 109 | ok |

## Findings

### 1. Haiku 4.5 cannot currently be a judge, and the reason is the important part
It fails `invalid_output` on every attempt because its rationale runs ~570 characters
against `RATIONALE_MAX_LENGTH = 280` — **despite `strict: true` and `maxLength: 280` being
sent on the wire**, and despite the model advertising `structured_outputs`.

This is the sharpest available evidence for ADR-0021's warning that the picker cannot be a
free list of the catalogue: **a capability flag is not a guarantee of constraint
enforcement.** ADR-0022 already established that key order must be checked on the raw text
rather than trusted; this extends the same finding to value constraints. M4's gating must
therefore rest on ADR-0026's real validating call, not on catalogue metadata — which is
what that call already does, and this is the case that proves it was worth building.

**The 280 cap should not be raised to accommodate a model.** It is a cost the caller pays in
their own agent's context window on every request (`packages/contracts/src/evaluate.ts`),
and relaxing a published contract to fit the weakest candidate inverts the relationship.

### 2. The tiers do not align across labs
There is no `gpt-5.6-mini`; the nearest OpenAI peer by price is `gpt-5.4-mini`, a generation
behind the seeded `gpt-5.6-sol`. So "cheap tier" and "same generation" cannot both hold, and
a picker that implies otherwise would be lying about comparability. `gpt-5.4-mini` was the
fastest and cheapest working model measured — $0.001753 at 1434ms, roughly **4x cheaper and
3x faster than Sonnet 5**.

### 3. Cheaper Gemini is a different question from less-deliberating Gemini
`gemini-3.7-flash @ low` is not a cheaper model, it is the seeded model deliberating less —
which isolates the effort variable and is exactly the A/B ADR-0022 defers to M6. The
genuinely cheaper Gemini, `gemini-3.5-flash-lite` at $0.30/$2.50, was **unpinnable** until
ADR-0025's amendment: `mandatory: true` with `default_effort: 'minimal'`, a value the pin
schema could not express. It is now pinnable and unmeasured.

Curiosity, single sample, not a conclusion: at `low` it burned **more** reasoning tokens
(109) than at `medium` (84), and ran slower. Worth re-checking before anyone reasons from it.

### 4. Latency varies far more across models than within one
Haiku's 15092ms — on the model advertised as the fast one — exceeds the 10s per-attempt
timeout. This corrected the timeout justification committed earlier the same day, which had
claimed comfortable headroom on the basis of three samples of one model. The value did not
change; the reasoning did. M2's k6 baseline should measure a distribution **across** models.

## What M4 should take from this
- Gate the picker on ADR-0026's validating call, not on `supported_parameters`.
- A model that passes the pin can still fail the output contract. Surface *why* — "rationale
  exceeded 280 characters" is actionable; "invalid output" is not.
- Show cost and measured latency per candidate. The 4x cost and 3x latency spread between
  `gpt-5.4-mini` and `claude-sonnet-5` is the whole reason a picker exists.
- Do not present cross-lab tiers as equivalent. They are not.

## Not done
Nothing here was seeded, and M1's four seed judges are unchanged. `gemini-3.5-flash-lite`
and the `xhigh`/`max` tiers are unmeasured. Judge QUALITY is unmeasured entirely — every
model above answered this one probe `true`, which says nothing about agreement with a human,
and that is M6's question, not this document's.
