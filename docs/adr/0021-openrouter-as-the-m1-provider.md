# ADR-0021: Judge inference routes through OpenRouter — for the exploration phase only

**Status:** Accepted · **Date:** 2026-08-29

## Decision
M1's real `ModelProvider` adapter is OpenRouter, and at M1 it is the only one. It replaces
the deterministic fake behind the port that already exists (`apps/api/src/llm/`), and it is
the path every `llm` judge's inference takes.

This decision is **phase-scoped and carries an expiry condition**, which is as much a part
of it as the choice itself: *before any tenant that is not us sends artifacts through a
panel, a direct first-party adapter (or a cloud-vendor one — Bedrock / Vertex AI /
Microsoft Foundry) must exist, and this ADR must be revisited.* The reason is data
governance, set out below. An OpenRouter-only system is fit for the phase where the only
artifacts flowing through it are our own; it is not fit for the phase after that.

Recorded as STACK_DECISIONS **D15**.

## Context
The product position is that **model choice belongs to the customer, in the UI, not to us,
in code**. That is what put an aggregator on the table at all: wiring one provider's SDK
would make us the decision-maker by default, and every judge configured before the picker
existed would carry that default forward into an immutable `jdv_`.

Three things made OpenRouter the cheap answer for this phase specifically:

- **The port already fits it.** `JudgeCall.model` is an opaque namespaced string, and
  `ProviderResult.servedBy` is documented as *"not always the model that was asked for — a
  provider may route."* That field was written for a future that turned out to be this one;
  it is currently unused and becomes meaningful the day the adapter lands.
- **It deletes the price table.** `llm/cost.ts` holds `MODEL_PRICES` as a hand-maintained
  literal, with a comment conceding it will need to become versioned and dated. A
  hand-maintained price list across the catalogue a model picker implies is wrong within a
  week of being written, and `priced: false` — a state the code deliberately reports rather
  than guesses around — would become the normal case rather than the exception. An
  aggregator that normalises cost centrally turns that from maintenance into a fetch.
- **The provider fence stays one hostname.** ADR-0016's machine-enforced rule
  (`apps/api/src/architecture.test.ts`) asserts no provider SDK or hostname appears outside
  `src/llm/`. With one aggregator that regex gains `openrouter.ai` once, rather than a new
  entry per provider for as long as the catalogue grows.

### Alternatives considered

**Direct adapters, one per provider.** The honest long-run answer, and what the expiry
condition points at. Rejected *for M1* on cost-per-unit-of-proof: each provider brings its
own auth shape, structured-output dialect, streaming quirks, rate-limit semantics, and an
error space that has to be hand-mapped onto `ProviderFailureKind`'s three values. That is N
ongoing maintenance surfaces bought before a single customer has asked for a second model.

**One provider, deliberately — Anthropic only.** The strongest competitor, and the least
work of any option; the port makes adding others additive rather than a rewrite. Rejected
because it contradicts the product position above, and because M7's "held-out comparison vs
frontier" is a materially weaker claim when *frontier* means the one provider we happened
to wire first.

**Cloud-vendor aggregation — Bedrock / Vertex / Foundry.** Genuinely different from
OpenRouter in trust profile rather than merely in branding: the enterprise customer already
holds the account and the signed agreement, so it is a procurement win, not just a
technical one. Rejected for M1 on three grounds. No single cloud carries the catalogue —
Bedrock has no OpenAI or Gemini models, Vertex has no OpenAI — so covering the major labs
means two or three cloud accounts and back to multiple credentials, merely heavier ones
(IAM roles and GCP service accounts rather than bearer tokens, plus per-region model
availability, per-model access enablement, and per-account quotas). It pulls against
ADR-0009: committing judge inference to Bedrock makes AWS load-bearing, which is the
opposite of "containers-first, Railway now, AWS as a documented escape hatch". And it costs
the demo — M0's headline property is fresh clone → one command → working system, and a
reader can reproduce an API key where they cannot reproduce an AWS account with Bedrock
model grants in the right region.

Worth recording for whoever revisits this, because it is a trap: **the same model is not
the same capability surface across access paths.** Server-side refusal fallbacks are
unavailable on Bedrock, Vertex and Foundry (client-side middleware substitutes); fast mode
is first-party only; web fetch is absent on Vertex; model id formats differ per path
(`anthropic.claude-opus-5` on Bedrock, bare ids on Vertex). A judge pinned to "the same
model" through a different path is not obviously the same judge.

**A self-hosted normalisation proxy (LiteLLM et al.).** Aggregator-shaped normalisation
with nobody else in the trust path — the strongest answer to the data-governance objection
short of going direct. Rejected for M1 as a second service to operate for a benefit that
only matters once third-party artifacts flow, and because it overlaps what `llm/` already
does by hand.

**Client-side abstraction libraries (Vercel AI SDK, LangChain).** Rejected outright, on a
different axis from the others: they normalise the code shape but leave the credential
count unchanged, so they do not answer the question, *and* they work directly against
ADR-0012. Resilience is hand-rolled here precisely so the work is visible; a library that
hides retry, backoff and error mapping deletes the artifact this project exists to
demonstrate. A proxy escapes that critique because it is operations rather than concealed
application code; a library does not.

### Why this is temporary, and what makes it so
The framing that settled the phase-scoping is that the real question is not *how many keys
do we hold* but **who holds the billing and data-processing relationship**.

The first-party enterprise APIs do not train on API traffic by default, and zero-data-
retention is available to eligible customers (with the notable interaction that it
constrains model availability — Claude Fable 5 requires 30-day retention and is not offered
under ZDR). Cloud aggregation does not improve on that guarantee; what it improves is
*procurement* — one DPA the customer already holds, one auditable residency story.

**OpenRouter is the weakest of the options on exactly this axis.** It routes to many
upstream providers, and some tiers — particularly free and heavily discounted ones — log or
train on prompts. Avoiding those is a configuration we must set and keep set, not a default
we inherit. That is tolerable while the artifacts are our own. It stops being tolerable the
moment LabelLoop processes a customer's agent outputs, because those may carry that
customer's users' data, and we would then owe them a DPA whose promises must be backed by
what our upstream actually promises us. *"It depends which provider the router picked that
day"* is not a sentence that survives a contract review.

**These policy specifics are stated here from a dated understanding and are the one part of
this ADR that must be re-verified from primary sources** — Anthropic's commercial terms,
AWS's Bedrock data-protection documentation, Google Cloud's Vertex terms, and OpenRouter's
own data policy — before the successor adapter is designed. They change, and the argument
above is only as good as they are.

## Consequences
- M1 gains one adapter, not a provider matrix. The shared provider contract test suite that
  already exists beside the port is what it is held to.
- `openrouter.ai` is added to the hostname regex in `architecture.test.ts`. The fence gains
  one entry and is expected to gain no more until the successor adapter arrives.
- `MODEL_PRICES` stops being the source of truth for cost. How cost is actually sourced —
  per-call from the response, or from a periodically-refreshed catalogue — is an M1
  implementation question, but the hand-maintained literal does not survive M1.
- **Unresolved and routed to M1 research, not settled here:** `judge_versions.model` is a
  single nullable text column, and ADR-0003 freezes whatever is written to it forever. Given
  that the access path changes the capability surface, an immutable judge version probably
  needs to pin the *route* as well as the model name — otherwise re-running a judge through
  a later direct adapter is not provably the same judge, and the "same judge, served by
  something cheaper" graduation story (ADR-0019, M7) has nothing to anchor to. This must be
  answered before M1 writes a migration, because the column is public contract.
- The model picker cannot be a free list of the catalogue. Judge output is a parsed
  structured contract, and support for it varies per model; the picker must be
  capability-gated against what each model actually supports. `ProviderFailureKind`'s
  `invalid_output` already represents the failure, but representing it is not the same as
  not causing it.
- A single intermediary now sits in front of every judge call. For M2 this is arguably
  useful — the circuit breaker acquires a real failure mode to trip on — but it is a
  concentration of risk and is named here rather than discovered later.
- **The expiry condition is a commitment, not a note.** It should be re-read when M5's
  dogfooding tenant goes live (still us, so still fine) and acted on before any tenant that
  is not us. If BYOK arrives first, it moots part of this: a per-tenant encrypted credential
  store is required under every option, and OpenRouter defers that build rather than
  deleting it.

Log: `thoughts/shared/progress/decisions-log.md` (2026-08-29)
Register: STACK_DECISIONS D15
