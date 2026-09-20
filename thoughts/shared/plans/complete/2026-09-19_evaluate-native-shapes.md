---
date: 2026-09-19T04:00:00Z
author: claude-code
status: complete
approved_at: 2026-09-19T11:10:38Z
approved_by: Pat Keenan
milestone: M5
topic: evaluate-native-shapes
related_adrs: [0001, 0003, 0019, 0033, 0037, 0060, 0067, 0073, 0074, 0075, 0076, 0077, 0078]
research: thoughts/shared/research/2026-09-19_evaluate-native-shapes.md
---

# Evaluate accepts native shapes (ADR-0073)

## Goal
Replace the evaluate contract's `artifact` (string) + `context` (flat string map) with ADR-0073's
four roles — `input` and `output` (required, any JSON), `reference` and `metadata` (optional) — and
have LabelLoop, not the integrator, present them: by shape, in time order, with only the agent's
final answer or proposal marked as judged. Proven first by a reversible experiment
(`spike/github-triage-agent`, three real agents through OpenRouter). **Existing traces are never
removed, and every phase is reversible until the last one**: storage changes are additive, the
old columns stay and keep being written through phases 1–4, and phase 5 — once everything else
is verified — drops them (stakeholder, 2026-09-19).

**Milestone: M5 — a prerequisite, like members was.** M5 phase 4 builds the annotation queue and
its review payload on the trace's shape, and annotations pin to traces; landing this first means
nothing in M5 is built on the shape it replaces. M5 resumes at phase 4 afterwards (and r5, still
under review in #74, is redrawn for the transcript layout).

One branch and PR per phase (`feat/shapes-p1-contract`, …), per CLAUDE.md "Branching".

---

## Phase 1 — Contract and storage (additive)

### Changes
- `packages/contracts/src/evaluate.ts` — `evaluateRequestSchema` becomes
  `{ input: z.json(), output: z.json(), reference?: z.record(z.string(), z.json()),
  metadata?: z.record(z.string(), z.string()) }`; `artifact`/`context` are removed from the
  REQUEST (ADR-0073's recorded `/v1` exception). A size cap replaces
  `EVALUATE_ARTIFACT_MAX_LENGTH`: **64 KiB** on the four roles serialised, a field-level
  `VALIDATION_ERROR`. OpenAPI descriptions and examples rewritten — `output` described as "your
  agent's final answer or proposal", `input` as "everything it was given or did to get there".
- `packages/db/migrations/0013_native_shapes.sql` + `schema/traces.ts` — **additive**: new
  nullable `input`, `output`, `reference`, `metadata` jsonb columns; `artifact` becomes nullable;
  `context` unchanged. **Backfill** in the same migration: `output = to_jsonb(artifact)`,
  `reference = context`, `input` left NULL (a legacy row never recorded one). Nothing is deleted.
- `apps/api/src/services/evaluate.ts` — both `insertTrace` paths (collecting, judged) write the
  four roles, **and dual-write** `artifact` = the output as text (a string verbatim, anything
  else `JSON.stringify`d) with `context` NULL, so reverting this PR leaves every new row readable
  by the old code.
- `apps/api/src/repositories/traces.ts` — `TraceRow` gains the four roles; the detail read
  returns them (a legacy row: `input` null, `output`/`reference` from the backfill). The list read
  still selects none of them.
- `apps/api/src/routes/internal/traces.ts` — the detail response carries `input`, `output`,
  `reference`, `metadata` instead of `artifact`/`context`.
- `packages/db/src/schema/jsonb-encoding.test.ts`, `verdict-cost.test.ts`,
  `jobs/record-evaluation.test.ts`, `routes/public/v1/evaluate.test.ts`,
  `contracts/src/evaluate.test.ts`, `openapi.test.ts` — moved to the new shape; new cases below.

### Steps
- [x] Contract: four roles, 64 KiB cap, OpenAPI text
- [x] Migration 0013: add columns, backfill, `artifact` nullable — nothing dropped
- [x] Evaluate service writes the four roles and dual-writes `artifact`
- [x] Trace repository and detail route return the four roles
- [x] Tests: each JSON shape accepted (string, object, array, messages with tool calls); `input`
      and `output` required; the cap refuses at 64 KiB + 1 on the field; `artifact`/`context` in a
      request are a 422; the backfill maps a pre-migration row exactly; a new row's `artifact`
      equals its rendered output; **row count unchanged by the migration**

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run db:migrate` on a copy of the
      local database, then the row-count and backfill assertions

### Manual verification
- [ ] `curl` a chat-shaped and a proposal-shaped call; both answer as before; `psql` shows the
      four roles stored and `artifact` dual-written; every pre-existing trace is still there

---

## Phase 2 — The judge prompt (`llm/`)

### Changes
- `apps/api/src/llm/provider.port.ts` — `JudgeCall` takes `input`, `output`, `reference?` in
  place of `artifact`/`context`.
- `apps/api/src/llm/render-for-model.ts` (new) — ONE pure function from a role's value to prompt
  text: a string verbatim; a message array as ordered turns, tool calls as
  `→ name(args) ⇒ result`; anything else as indented JSON. Shared by every adapter.
- `apps/api/src/llm/openrouter-provider.ts` `messages()` — sections `Question`, `Reference`,
  `Input`, `Output`; the system line says it judges **the output**, with the input as evidence.
- `apps/api/src/llm/fake-provider.ts` — seeds from the rendered roles; sentinels read the start of
  a string `output` (k6 and the failure tests depend on them).
- `apps/api/src/llm/validate-pin.ts` — the probe call in the new shape.
- `provider.contract-test.ts`, `gateway.test.ts`, `spans.test.ts`, `openrouter-provider.test.ts`,
  `fake-provider.test.ts` — the new shape; `render-for-model.test.ts` covers every shape.

### Steps
- [x] `render-for-model.ts` with tests (string, fields, OpenAI and Anthropic tool calls, JSON)
- [x] Port, OpenRouter prompt, fake provider, pin probe moved over
- [x] Sentinels proven on a string `output`

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`; `bun run verify:pin` against one real
      model (a real call — the only proof the new prompt still produces valid structured output)

### Manual verification
- [ ] One evaluate call against a JUDGED panel (the seed's) returns verdicts whose rationales
      read the output, not the input

---

## Phase 3 — One renderer, both surfaces

### Changes
- `apps/web/src/components/shaped/` (new; rebuilt clean from the spike's `shaped-request.tsx`,
  never ported — Phase C) — `to-steps.ts` (pure: OpenAI + Anthropic formats → turns and tool-call
  steps, results paired by id), `markdown.tsx` (a thin wrapper over **`markdown-to-jsx`** with raw
  HTML disabled, so a caller's `<img onerror>` renders as text, and link URLs restricted to
  http(s) and mailto),
  `shaped-trace.tsx` (Reference collapsed → the flow, one list in time order → only the final
  reply or the proposal on the judged surface → metadata as one faint line).
- `apps/web/src/components/shell/trace-drawer.tsx` — the Request section becomes the shaped view
  for every trace. A LEGACY row (`input` null) renders its output on the judged surface with its
  old context as Reference and a faint "recorded before inputs were captured" note — never an
  empty Input block.
- Speaker labels neutral: `user` → **User**, `assistant` → **Agent** (the spike labelled an
  operations ticket "Customer").
- Token-only styling, so M5 phase 5 reuses it under `data-surface="annotator"` unchanged.
- `apps/web/package.json` — `markdown-to-jsx` (zero dependencies); `docs/STACK_DECISIONS.md` gains
  its row.
- `apps/web/src/components/shaped/*.test.ts(x)` — `bun test apps/web` covers the pure parts and
  the wrapper's safety settings.

### Steps
- [x] `to-steps.ts` + tests (both formats, pairing by id, an unpaired call, the last-reply rule)
- [x] `markdown-to-jsx` added, STACK_DECISIONS row; `markdown.tsx` + tests (`<img onerror>` and
      `<script>` stay text; a `javascript:` link is not rendered as a link)
- [x] `shaped-trace.tsx`; drawer and trace page use it; legacy rows handled
- [x] Neutral speaker labels

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`

### Manual verification
- [ ] In the console: a chat trace reads top to bottom with only the final reply purple; a
      tool-calling turn shows its calls as steps OUTSIDE the purple reply; a proposal shows the
      investigation, then the proposal alone on the judged surface; a pre-migration trace still
      reads sensibly

---

## Phase 4 — Every caller of the old shape

### Changes
- `apps/web/src/components/shell/snippet.tsx` — curl, Node and Python in the new shape: the
  example is a chat (`input` = messages, `output` = the reply), the shape most integrators hold.
  The `your_agent_decision`-in-`context` example — the ambiguity ADR-0073 removes — is gone.
- `infra/k6/load-lib.js` — `evaluate(output)` posts `{ input, output }`; sentinels on `output`.
- `scripts/seed.ts` — any evaluate it makes, in the new shape.
- `apps/api/src/docs.ts`, `README.md` (the curl; the triage persona restated so the ROUTE is the
  output and the issue the input), `docs/adr/0037-*.md` (an amendment note pointing at ADR-0073),
  `docs/CONVENTIONS.md` (the evaluate bullet; the `/v1` exception recorded beside the rule it
  excepts), `docs/PRODUCT.md`, `CLAUDE.md` domain paragraph ("sends an artifact" → "sends its
  output").
- **The end-to-end proof:** the three spike agents on `spike/github-triage-agent`, moved off the
  JSON-in-strings encoding to the real contract, run clean against this API. Still throwaway.

### Steps
- [x] Snippet in the new shape
- [x] k6 and seed moved; the k6 smoke passes in CI
- [x] README, ADR-0037 note, CONVENTIONS, PRODUCT, CLAUDE.md, docs.ts
- [x] The three spike agents run against the real contract

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`; CI's
      compose + k6 smoke job green

### Manual verification
- [ ] Copy the snippet from a new panel's Overview, run it, open the trace — it reads as a chat
- [ ] Run the operations agent against a fresh panel; its traces read as investigation → proposal

---

## Phase 5 — Drop the old columns (after phases 1–4 are verified)

The stakeholder's call (2026-09-19): once the new shape has been lived with through phase 4, the
old columns go. **This is the one irreversible phase**, which is why it is last and its own PR.

### Changes
- `packages/db/migrations/0014_drop_artifact_context.sql` + `schema/traces.ts` — drop `artifact`
  and `context`; `output` becomes NOT NULL (every row has one since the phase-1 backfill).
- `apps/api/src/services/evaluate.ts` — the dual-write stops.
- Anything still reading `artifact`/`context` (there should be nothing after phase 4; the
  typecheck proves it once the columns leave the schema).

### Steps
- [x] Confirm every row has `output` (`SELECT count(*) WHERE output IS NULL` = 0) before writing
      the migration
- [x] Migration, schema, dual-write removed
- [x] Row count unchanged

### Automated verification
- [x] `bun test`, `bun run typecheck`, `bun run lint`, `bun run --cwd apps/web build`

### Manual verification
- [ ] Every trace — pre-migration, chat, tool-calling, proposal — still opens and reads correctly

---

## Decisions made
ADR stubs spawned at approval: decisions 1–3 → ADR-0074, 4 → 0075, 5–6 → 0076, 8 → 0077, 9 → 0078.
Decisions 7 and 10–12 are recorded here only: they are deferrals or view details.

1. **Additive migration with a backfill; nothing dropped** (stakeholder constraint) — over
   rewriting `traces` in place or dropping and reseeding; existing traces are kept. The old
   columns are dropped in phase 5, after phases 1–4 are verified (stakeholder, 2026-09-19).
2. **Dual-write `artifact` through phases 1–4, stopped in phase 5** — over writing only the new
   columns; a revert of any of phases 1–4 leaves every row readable by the code it reverts to,
   which is what "reversible" has to mean with forward-only migrations (ADR-0006).
3. **Legacy rows keep `input` NULL** — over inventing an input from their old context; a
   pre-migration trace never recorded one, and the view says so rather than guessing.
4. **A 64 KiB cap on the four roles serialised**, a field-level 422 — over a per-field string
   length (a long conversation is the real growth risk; the taxonomy has no 413) and over 100 KiB
   (stakeholder asked, 2026-09-19): RAISING a cap later breaks no caller and lowering one does,
   and the cap also bounds judge cost — everything under it is in every judge's prompt, ~16k
   tokens at 64 KiB against ~25k at 100. Raise it when a real integration hits it.
5. **One pure render-for-model function in `llm/`** — over each adapter formatting its own; the
   prompt is the same whatever the provider.
6. **Every existing judge's prompt changes, recorded, not versioned** — ADR-0033's templates were
   never built, and only seed and test judges exist; building templates now would be machinery
   with nothing to protect. Revisit when a real judge would be affected.
7. **Panel-level reference is deferred** — over building it now; it needs a panel-version field,
   authoring UI, and the version n+1 write path M6 owns. Per-call `reference` covers it until
   then (the experiment's policy sat collapsed and read fine). Parked.
8. **`metadata` is withheld from the annotator payload** (for M5 phase 4) — ADR-0067's default:
   what the annotator surface never receives it cannot leak; it may carry customer ids. The
   console shows it.
9. **Markdown via `markdown-to-jsx`, raw HTML disabled** (stakeholder chose a package,
   2026-09-19) — over `react-markdown`, safe by default but pulling the unified/remark tree
   (≈10 direct dependencies and many transitive), against CONVENTIONS' "no large transitive
   tree"; and over a hand-rolled subset. `markdown-to-jsx` has zero dependencies, is maintained
   (9.10.3, updated 2026-09-15) and renders to React elements. A STACK_DECISIONS row and an ADR.
10. **Neutral speaker labels, User / Agent** — over chat-specific "Customer", which misnamed an
    operations ticket in the experiment.
11. **Legacy traces render in the new view**, not the old one — one view to maintain, with a note
    on what a legacy row lacks.
12. **The onboarding snippet's example is a chat** — the shape most integrators already hold,
    and the one that shows `input` as a messages array.

## Explicitly NOT doing
- **Panel-level reference material** — parked (decision 7).
- **Bulk seed upload, live sampling modes, backtesting** — parked 2026-09-19.
- **Versioned prompt templates (ADR-0033)** — decision 6.
- **Judging individual tool calls or steps** — the output is the final answer or proposal only.
- **Rendering images, files or other non-text outputs** — JSON only.
- **A `/v2`** — ADR-0073's recorded exception.

## Open questions for the human
All four resolved by the stakeholder on 2026-09-19:
1. **Merge order** — agreed: branch from `main` after #72 and #73 merge; #74 (r5) held for a
   redraw; M5 phase 4's annotations migration renumbers to 0015 (this plan takes 0013 and 0014).
2. **Cap** — 64 KiB kept (decision 4).
3. **Markdown** — a package: `markdown-to-jsx` (decision 9).
4. **Old columns** — dropped once the rest is done: phase 5.

## Deviations

1. **Phase 1 carries two bridges the plan scheduled later** (stakeholder, 2026-09-19). As
   written, phase 1 would have merged red: once `artifact` is a 422, CI's required k6 smoke
   posts `{ artifact }`, and once the detail route stops returning `artifact`/`context`,
   `apps/web` no longer typechecks. So phase 1 also moves `infra/k6/load-lib.js`'s
   `evaluate()` and `smoke.js` to `{ input, output }` (phase 4 still owns the rest of k6's
   wording), and the trace drawer gets a STOPGAP Request block — output, input, reference as
   text, "Recorded before inputs were captured." for a legacy row — which phase 3 replaces.
2. **The judge call is bridged in phase 1, and `input` does not reach judges until phase 2.**
   `JudgeCall` keeps `artifact`/`context` until phase 2 changes the port, so the service passes
   the output as text (a string verbatim, else JSON) as `artifact` and each reference value as
   text as `context`. Sentinels on a string `output` work unchanged.
3. **The retired fields are refused by a STRICT request object**, not by per-field `never`
   schemas. Zod's `z.never()` has no OpenAPI rendering, and a strict object also says
   `additionalProperties: false` in the spec, which is true. The issue has path `""` rather
   than `artifact`, and its message names the four replacement fields. It also means any
   unknown key is a 422, not only the two retired ones.
4. **`input`/`output` are `z.custom` with a stated OpenAPI type, not `z.json()`.** `z.json()`
   is recursive, and generating the OpenAPI document from it overflows the stack. The check
   only refuses absence, because a parsed JSON body is already JSON. `null` is accepted as
   a value: it is JSON, and the plan said any JSON.
5. **The 64 KiB cap is the SUM of each present role's serialised UTF-8 bytes**
   (`evaluateRolesBytes`), which makes the boundary exact to test. The issue is attributed to
   the largest role, which is where a caller has to cut.
6. **The detail route widens the roles to `unknown` on the way out.** A recursive `JsonValue`
   through Hono's RPC inference fails the console's typecheck with TS2589 (instantiation too
   deep). The console narrows by shape at runtime anyway (phase 3), and storage and
   validation keep `JsonValue`.

Phase 1 evidence (2026-09-19): 0013 applied to a `pg_dump` copy of the local database:
4,593 rows before and after, 0 `output` NULL, 0 non-string `output`, 0 `output` ≠ `artifact`,
0 `reference` ≠ `context`, 0 rows with an invented `input`/`metadata`. Local k6 smoke: every API
and evaluate check passed. The two console checks could not reach the Vite dev server from
Docker; CI serves the web container instead.
7. **Phase 2 is stacked on phase 1's branch** (`feat/shapes-p2-judge-prompt` from
   `feat/shapes-p1-contract`). It is retargeted to `main` once #77 merges.
8. **Speaker labels in the PROMPT are neutral too** (User / Agent / System). Decision 10 named
   them for the view; the model reads the same transcript, so one vocabulary serves both.
9. **Sentinels read a string `output` only**. A sentinel inside an object output, or anywhere
   in `input`, is judged normally: only the thing judged can drive the fake. The fake's
   verdict seed is the rendered question, input, output and sorted reference, so the input
   now changes the verdict.

Phase 2 evidence (2026-09-19): `bun run verify:pin openrouter:anthropic/claude-sonnet-5`
returned valid structured output in the new prompt, with key order rationale → reasons →
verdict → confidence, 2,795 tokens in, and a verdict of true @ 0.95. A direct run of the real
Haiku 4.5 judge used an outage chat whose tool result showed a 98% error rate. A "low-priority
cosmetic" reply was judged false and a "paging on-call, SEV-1" reply true. Both rationales judged
the reply and cited the tool result as evidence.
10. **Markdown safety goes beyond "raw HTML disabled"**. HTML blocks are ignored as well, link
    URLs are limited to http(s) and mailto, and images are never fetched: a remote image is a
    beacon the caller controls, and the plan renders no non-text output. `forceBlock` is on, so
    a one-line reply with **bold** stays one paragraph. STACK_DECISIONS row D18 records all of it.
11. **The drawer's clamping is gone with the stopgap.** The shaped view reads top to bottom and
    the drawer scrolls. Tool-call results and system prompts are collapsed by default instead,
    which is where the length actually was in the spike's traces.
12. **A system message is a collapsed "System prompt" row**, not a turn. The spike dropped system
    messages altogether, and dropping evidence would be worse than collapsing it.
13. **Visual check was done on a throwaway preview page**, not the signed-in console, because
    signing in means entering a password. The page rendered the real `ShapedTrace` on the console
    surface with a chat, a tool-calling turn, a proposal and a legacy trace, and was deleted
    before commit. The signed-in check is the stakeholder's manual verification.
14. **The seed makes no evaluate call**, so there was nothing to move: its traces come from
    `scripts/seed-judges.ts` and the walkthrough's curl, both of which are in the new shape.
15. **FOUR spike scripts, not three.** `support-chat/run-tools.ts` — the tool-calling bot, the
    one that produced the tool-call traces the experiment settled `output` on — is a fourth
    entry point and was moved with the others. The `--shape` fork is gone from all of them:
    there is one way to send a conversation now. Committed on `spike/github-triage-agent`
    (`12aaef6`), still throwaway and still unpushed.
16. **The agents ran against the support-chat panel** (stakeholder's choice, 2026-09-19):
    triage 3 issues, ops 2 tickets, chat 2 conversations × 2 turns, tool-calling chat 1
    conversation. Every call accepted; `psql` shows `input` stored as a real messages array with
    `tool_calls`, `output` as a string, `reference` as an object. One turn returned an empty
    reply, which is the view's "No reply was sent." case arriving from a real agent.
17. **`docs/PRODUCT.md`'s triage persona and ADR-0037 now put the DECISION in `output`.** The
    prose said the issue was the artifact and the route travelled in `context` — the exact
    ambiguity ADR-0073 removes. ADR-0037 keeps its decision and carries an amendment note.
18. **CONVENTIONS records the `/v1` exception directly under the rule it excepts**, rather than
    beside the evaluate bullet, so nobody reads "breaking change = new version" without it.
19. **README carries a "what goes in which role" table** (stakeholder, 2026-09-19), with the four
    roles and the shapes an agentic caller actually takes — an agent that acts, a coding agent, a
    RAG answer, a triage bot — plus the tie-breaker: if the agent saw it, it is `input`; if only
    the judge needs it, it is `reference`. The snippet stays a chat (decision 12), but the
    reference documentation no longer reads as though chat were the design.
20. **A neutral step format is PARKED, not built** (stakeholder, 2026-09-19). The view and the
    judge prompt recognise OpenAI and Anthropic tool calls; a framework's own step list is
    stored and judged identically and reads as fields. `docs/PARKING_LOT.md` records the
    proposal, the two files it touches, and its promotion condition.
21. **The row-level backfill test could not survive the contraction, and was replaced rather
    than deleted.** `packages/db/src/schema/native-shapes.test.ts` used to write a pre-0013 row
    and run 0013's own `UPDATE` over it; 0014 removed the columns that statement reads, so the
    replay is impossible, not merely weaker. It now asserts the same properties against the
    migration FILES: 0013 adds the four roles and contains no `DROP`/`DELETE`/`TRUNCATE`, its
    backfill maps `artifact`→`output` (via `to_jsonb`, never a parse) and `context`→`reference`
    and touches neither `input` nor `metadata`, 0014 drops exactly two columns and no rows, and
    `output` takes NOT NULL while `input` stays nullable for the legacy rows.
22. **The 47 spike traces keep their content** (stakeholder chose to leave them, 2026-09-19).
    Their encoded roles were copied into `reference` by 0013, so dropping `context` took nothing
    with it: they still read as legacy traces whose reference holds the experiment's JSON.

Phase 5 evidence (2026-09-19): `output IS NULL` = 0 across 4,610 rows before the migration was
written. After it: 4,610 rows, `artifact` and `context` absent from `information_schema`, a live
evaluate call stored its roles and made 4,611. The database now holds 4,593 legacy rows
(including the 47 spike ones), and 18 in native shapes.

## Shipped

| Phase | PR | What landed |
|---|---|---|
| 1 | #77 | The four-role contract with a 64 KiB cap; migration 0013 (expand + backfill); dual-write |
| 2 | #78 | `JudgeCall` takes the roles; `render-for-model.ts`; the prompt judges the OUTPUT |
| 3 | #79 | The shaped view — transcript, tool steps, the judged surface; `markdown-to-jsx` (D18) |
| 4 | #80 | Snippet, k6, README (with the roles table), CONVENTIONS, PRODUCT, CLAUDE.md, ADR-0037 note; all four spike agents on the real contract |
| 5 | #81 | Migration 0014: `artifact` and `context` dropped, `output` NOT NULL, dual-write removed |

**Parked from this work:** a neutral step format for framework-native agent traces
(`docs/PARKING_LOT.md`), and panel-level reference material (decision 7).
