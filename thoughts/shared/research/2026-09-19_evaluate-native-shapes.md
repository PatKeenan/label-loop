---
date: 2026-09-19T01:00:00Z
author: claude-code
status: draft
milestone: M5
topic: evaluate-native-shapes
related_adrs: [0001, 0003, 0019, 0033, 0034, 0037, 0060, 0066, 0067, 0073]
---

# Evaluate accepts native shapes (ADR-0073) — what it touches

## Problem summary
`POST /v1/.../evaluate` takes `artifact` (string ≤32k) and `context` (flat `string→string`
map). Two real spikes (2026-09-18: GitHub triage, support chat; 130 traces) showed integrators
writing render functions to flatten structured data, a transcript flattened into one string,
and a trace view that reads backwards. ADR-0073 replaces the pair with `input`/`output`
(required, any JSON) + `reference`/`metadata` (optional), rendered by shape, chronologically,
with shared reference material moving to the panel version — amended in place on `/v1`. This
must land before M5 phase 4, whose review payload and annotations would otherwise pin to the
old shape.

## Relevant files (one line each)
**Contract**
- `packages/contracts/src/evaluate.ts` — `evaluateRequestSchema` (artifact/context, `EVALUATE_ARTIFACT_MAX_LENGTH = 32_000`), OpenAPI descriptions and examples; the one source every consumer reads.
- `packages/contracts/src/evaluate.test.ts`, `openapi.test.ts` — assert the request shape and the published document.

**API**
- `apps/api/src/routes/public/v1/evaluate.ts` — both routes (panel, single judge) share the schema; summary/description text says "artifact".
- `apps/api/src/services/evaluate.ts` — passes `artifact`/`context` into every judge call (≈l.106) and into `insertTrace` on BOTH paths (collecting ≈l.369, judged ≈l.418). Trace write is inline; the `record-evaluation` job carries only ids, so the queue payload is unaffected.
- `apps/api/src/repositories/traces.ts` — `TraceRow.artifact: string`, `context: Record<string,string>|null`; the detail read selects both, the list deliberately does not.
- `apps/api/src/routes/internal/traces.ts` — trace detail returns `artifact`/`context` to the console (staff-only, `trace: [read]`).
- `apps/api/src/docs.ts` — Scalar/OpenAPI intro copy ("send an artifact").

**Judge calls (`llm/`, the only provider gateway)**
- `apps/api/src/llm/provider.port.ts` — `JudgeCall.artifact: string`, `context?: Record<string,string>`; every adapter implements it.
- `apps/api/src/llm/openrouter-provider.ts` `messages()` — THE prompt assembly: `Question:` / `Context:` (key: value lines) / `Artifact:`. The system line says "You judge one artifact".
- `apps/api/src/llm/fake-provider.ts` — seeds randomness from `artifact`+context, and **sentinel prefixes on `artifact`** (`unavailable`, `misconfigured`, `invalidOutput`, `slow`) drive failure tests and k6.
- `apps/api/src/llm/validate-pin.ts` — `PROBE_ARTIFACT` in the pin-validation probe call.
- `apps/api/src/llm/provider.contract-test.ts`, `gateway.test.ts`, `spans.test.ts`, `openrouter-provider.test.ts` — build `JudgeCall`s with `artifact`.

**Storage**
- `packages/db/src/schema/traces.ts` — `artifact text NOT NULL`, `context jsonb` (`jsonbColumn<Record<string,string>>`).
- `packages/db/src/schema/jsonb-encoding.test.ts`, `verdict-cost.test.ts`, `record-evaluation.test.ts` — insert traces with these columns.
- `packages/db/src/schema/panel-versions.ts` — where panel-level reference material would live (immutable, ADR-0003).
- Local DB: 4,546 traces, 209 with context, longest artifact 8,201 chars. **No deployed environment** (SENIORITY_CHECKLIST, README) — every row is local.

**Console**
- `apps/web/src/components/shell/trace-drawer.tsx` — the Request section (ARTIFACT block, then CONTEXT key/value rows, each with show more/less); shared by the drawer and the trace page (M4 Deviation 75).
- `apps/web/src/routes/trace.tsx` — the trace page shell around that body.
- `apps/web/src/components/shell/snippet.tsx` — the onboarding snippet (curl/Node/Python), which teaches `"artifact": "what your agent produced, or decided about"` and `context: { your_agent_decision: "p2" }` — the ambiguity ADR-0073 removes.
- No markdown renderer in `apps/web/package.json`.

**Load, seed, docs**
- `infra/k6/load-lib.js` — `evaluate(artifact)` posts `{ artifact }`; smoke/ramp/soak/spike all go through it (sentinel strings included).
- `README.md` — the curl, and the triage persona (l.64: "the inbound issue is the artifact, the route… travels in `context`").
- `docs/adr/0037-*.md` — the same triage mapping, now backwards under ADR-0073.
- `docs/CONVENTIONS.md` "API rules" (the new-version rule ADR-0073 excepts; the evaluate bullet naming "artifact"), `docs/PRODUCT.md`, `CLAUDE.md` domain paragraph ("Their agent sends an artifact").
- `scripts/spikes/` on `spike/github-triage-agent` — throwaway, but the two integrations to rewrite as the proof.

**M5 phase 4 (not built)**
- Plan: `GET /internal/review/panels/:slug/next` returns `{ item_id, artifact, context }` and "no verdicts, scores, confidence, model, cost, key or trace id" (decision 8, ADR-0067). Under ADR-0073 it becomes `{ item_id, input, output, reference }` — plus panel reference.

## Patterns and constraints that apply
- **Breaking change = new version** (CONVENTIONS "API rules") — excepted once, by ADR-0073, because no external caller exists. The OpenAPI document and Scalar docs are the published contract (ADR-0002), so they change in the same PR.
- **Contracts are the single source of type truth** (CONVENTIONS "Repo shape"); API and web import the schema. `z.json()` exists in the installed zod 4.4.3 (checked) and is the natural "any JSON" type; it serialises to an unconstrained OpenAPI schema.
- **Every LLM call goes through `llm/`**; prompts live in versioned judge configs (CONVENTIONS "LLM-call rules").
- **ADR-0033: the prompt template is versioned and frozen onto the judge** — "artifact and context arrive… and are filled at call time", templates never deleted so a past request is reconstructable. **Not implemented**: there is no `template` column; `openrouter-provider.ts` `messages()` is the only template. Changing it silently changes the prompt of every existing `jdv_`.
- **Reasoning before verdict** (CONVENTIONS) — untouched; only the user message's data section changes.
- **Immutable versions** (ADR-0003) — panel-level reference on `panel_versions` means editing it cuts a new version, and a trace records which version (and so which reference) it was judged against.
- **Request bodies are never logged** (CONVENTIONS "Logging") and **no artifact-derived metric labels** (ADR-0042) — both hold unchanged for JSON; `metrics.cardinality.test.ts` guards the second.
- **ADR-0067**: the annotator payload withholds operator signals by construction. `metadata` is caller bookkeeping (ids, possibly PII) — not in the list, not obviously safe.
- **Raw provider payloads stored beside normalised fields** (CONVENTIONS "Data rules") — structured `output` makes the stored trace MORE faithful, not less.
- **Limited, not zero, dependencies** (CONVENTIONS "Dependency threshold") — a markdown renderer is a small library deciding safety (raw HTML must not render); planner's call, recorded.
- **Two surfaces, one renderer**: the console (dark/compact) and the annotator surface (light/comfortable) must render the same shapes; `useSurface` for anything portalled.
- The fake provider's **sentinel prefixes** must keep working for k6 and failure tests.

## Open questions for the human
1. **Existing rows.** All local. (a) Migrate: `output = to_jsonb(artifact)`, `reference = context`, `input = NULL` (so `input` is NOT NULL only for new rows / enforced in the API); or (b) drop and reseed (k6/soak data is disposable, but your two spike panels' 130 traces go too, unless re-run). Recommend (a): cheap, and keeps the spike traces for annotation.
2. **Is panel-level reference in this change, or next?** It needs a panel-version field, a way to author it (the create-panel dialog has name/slug/threshold only), and judge-prompt inclusion. Recommend: storage + API field + judge inclusion now; console authoring a small textarea on the panel, or deferred — your call.
3. **Prompt change for existing judges.** Adopt ADR-0033 properly now (a `template` column; existing judges frozen to `v1` = today's `messages()`, new judges to `v2`), or accept that every existing `jdv_`'s prompt changes? Recommend: accept, record it — only seed/test judges exist; build templates when a real judge would be affected.
4. **Does `metadata` reach the annotator?** A conversation id would let an annotator see "turn 3 of conv-15"; it may also carry customer ids. Recommend: withheld from the annotator payload (ADR-0067 default: what the surface cannot receive it cannot leak); the console shows it.
5. **Markdown.** Render string outputs as markdown (needs a sanitising renderer, e.g. a small dependency) or as plain pre-wrapped text for now? Recommend: markdown, no raw HTML, one dependency recorded — chat outputs are markdown in practice (the spike's `**Settings**`).
6. **Size cap.** Replace 32k-char artifact with one cap on the serialised request body (e.g. 64 KB for input+output+reference+metadata)? The spike's chat traces carried a ~1 KB policy per call; a long conversation history is the real growth risk.
7. **The single-judge route** (`/v1/judges/{id}/evaluate`) — same four roles; confirm no divergence.

## Recommended approach (input to planning)
One plan, four phases, each a PR:
1. **Contract + storage + API.** `input`/`output` as `z.json()`, `reference` object, `metadata` string map; migration 0013 adds `input`/`output`/`reference`/`metadata` jsonb, backfills from `artifact`/`context`, drops the old columns; `insertTrace` and the detail read move over; single byte cap. The fake provider keeps sentinels by reading a string `output`.
2. **Judge prompt.** One shared "render for a model" function in `llm/` (strings verbatim; `{role,content}[]` as `role: content` turns; other JSON pretty-printed), used by `messages()`; `Input`/`Output`/`Reference` sections; panel reference included when present.
3. **One renderer, two surfaces.** A shape-detecting component (text/markdown, transcript, fields, JSON) used by the trace drawer/page now and by the annotator surface in M5 phase 5 — chronological: reference collapsed, input, output highlighted, metadata small.
4. **Every caller of the old shape.** The onboarding snippet (curl/Node/Python), k6 `load-lib.js`, README curl and the triage persona, ADR-0037's mapping, CONVENTIONS/PRODUCT/CLAUDE.md wording; rewrite the two spikes against the new contract as the end-to-end proof.

Then redraw r5 for the transcript layout, and resume M5 at phase 4 with `{ item_id, input, output, reference }` as the review payload.
