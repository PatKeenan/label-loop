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
| `google/gemini-3.5-flash-lite` | minimal | 0.30 / 2.50 | 847 / 960 / 972 ms | 2 | $0.000766 avg | 0 | ok |

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
fastest and cheapest working model of the three labs' current generation — $0.001753 at
1434ms, roughly **4x cheaper and 3x faster than Sonnet 5** — though `gemini-3.5-flash-lite`
beats it on both (3a).

### 3a. `gemini-3.5-flash-lite` is the standout, and it was hidden behind a schema gap
Measured once the ADR-0025 amendment made it pinnable: **~$0.00077 per judge call at
~900ms** — roughly **9x cheaper and 4x faster than `claude-sonnet-5`**, passing key order
and the output contract on every run. Its latency spread across three samples was 847 / 960
/ 972 ms, the tightest of anything measured, against Haiku's 3078 / 5839 / 15092.

It is worth sitting with how close this came to never being looked at. It was unmeasurable
for one reason only: its `default_effort` is `minimal`, a value the pin schema could not
express, so it read as "blocked" rather than "cheapest and fastest". A contract gap did not
merely inconvenience the model — it removed the best cost-per-verdict candidate from
consideration silently. That is the failure mode a frozen column makes permanent, and the
argument for having widened the enum before P4 rather than after.

**It nuances ADR-0022, which is why it is recorded rather than just celebrated.** That ADR
treats `reasoning.mandatory: true` as meaning the model deliberates privately, we are billed
for it, and we cannot see or store it. This model is `mandatory: true` and reported **0
reasoning tokens on all three runs at `minimal`**. So mandatory does not by itself imply
billed hidden deliberation — the effort pinned to it is what decides. The concern is real
for `gemini-3.7-flash` (84 tokens at medium, 109 at low) and absent here. A picker warning
that says "this model always reasons" would be, for this model, wrong.

### 3b. Cheaper Gemini is a different question from less-deliberating Gemini
`gemini-3.7-flash @ low` is not a cheaper model, it is the seeded model deliberating less —
which isolates the effort variable and is exactly the A/B ADR-0022 defers to M6. The
genuinely cheaper Gemini, `gemini-3.5-flash-lite` at $0.30/$2.50, was **unpinnable** until
ADR-0025's amendment: `mandatory: true` with `default_effort: 'minimal'`, a value the pin
schema could not express. It is now pinned and measured — see 3a.

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
- Show cost and measured latency per candidate. The spread is the whole reason a picker
  exists: **~9x cost and ~4x latency** between `gemini-3.5-flash-lite` and
  `claude-sonnet-5`, on a probe both answered identically.
- Show latency VARIANCE, not just a number. `gemini-3.5-flash-lite` held 847–972ms while
  `claude-haiku-4.5` ranged 3078–15092ms; a median would have hidden the difference that
  actually matters to a caller.
- Do not warn "this model always reasons" from `reasoning.mandatory` alone. It was true for
  `gemini-3.7-flash` and false for `gemini-3.5-flash-lite` at `minimal` (see 3a).
- Do not present cross-lab tiers as equivalent. They are not.

## Not done
Nothing here was seeded, and M1's four seed judges are unchanged. The `xhigh`/`max` tiers
are unmeasured, as is `gemini-3.5-flash-lite` at any effort above `minimal`. Judge QUALITY is unmeasured entirely — every
model above answered this one probe `true`, which says nothing about agreement with a human,
and that is M6's question, not this document's.
