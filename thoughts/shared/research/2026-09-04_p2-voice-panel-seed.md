---
date: 2026-09-04T00:00:00Z
author: claude-code
status: draft
milestone: M5
topic: p2-voice-panel-seed
related_adrs: [0034, 0035, 0036, 0019, 0003, 0025, 0026, 0032, 0033]
research: thoughts/shared/research/2026-08-31_adr-0034-two-valued-polarity.md
plan: thoughts/shared/plans/complete/2026-09-01_p1-two-valued-polarity.md
---

# P2 — the voice panel: replacing the seeded panel

## Problem summary

P1 landed the enum narrowing and left the seed holding **one knowingly invalid judge**
(`needs-human`), kept only because a panel with no judges makes `evaluate` throw
`NOT_FOUND`. P2 deletes it and authors the replacement panel: AI-generated writing judged
against the author's own register (D3), four `llm` judges over the three existing
`SEED_MODEL_*` variables, mixed polarity, at least one `required` veto, every judge cleared
against **both** bars — expressible (ADR-0034) and evaluating rather than working
(ADR-0036). The blocker is not code: **D7's open-coding pass has not happened and nothing
in the repo stands in for it.** Everything else here is an edit inventory that can be
written the day the four judges are chosen.

## Relevant files and why each matters

**The seed — the substance of the phase**
- `scripts/seed-judges.ts:64-92` — the `JUDGES` array (one entry) and the placeholder doc
  comment that names ADR-0036 and points at P2. Deleted and rewritten wholesale.
- `scripts/seed-judges.ts:47-51` — `MODEL_VARS`, three variables for four judges *on
  purpose*: three labs, legible price and latency spread. P2 restores that mapping; the
  `JudgeSeed.modelVar` comment currently says only `SEED_MODEL_A` is read and must go back.
- `scripts/seed-judges.ts:95-118` — `PINNED_EFFORTS` pins `google/gemini-3.7-flash` to
  `medium` (reasoning is mandatory there); anything absent is `none`. Whichever judge lands
  on Gemini inherits that, unchanged.
- `scripts/seed-judges.ts:190-230` — `validateSeededPins`, no escape hatch (ADR-0026). Four
  judges means up to four real sequential calls per fresh seed *when keys are set*; the
  `fake:deterministic` default path stays free and offline.
- `scripts/seed.ts:46-48, 110-124` — `PANEL`/`PANEL_VERSION` ids and the `issue-triage`
  panel row. **`jud_`/`jdv_` ids are derived from the array index** (`SEEDJDG${index}`),
  and every insert is `ON CONFLICT (id) DO NOTHING`, so a database seeded at P1 keeps
  `needs-human` under new judge 0's id and silently mixes panels. Same hazard on the panel
  row: a new slug never lands on an existing `pnl_`. `down -v` is mandatory, not advisory.
- `scripts/seed.ts:115-117, 261` — `threshold 0.5`, hard-coded in the insert and restated in
  the console line. Weights and threshold are chosen together so the README example is
  legible.

**Where the seeded judge set is written down a second, third and fourth time**
- `infra/k6/smoke.js:32` — `const JUDGES = ['needs-human']`, plus the panel default at
  `:22` and the request body at `:97` (no `context`). The P1 deviation record names this as
  the one gate that actually exercises the seeded panel end to end, and it caught P1's miss
  only on CI for PR #35.
- `packages/db/src/schema/relations.test.ts:35, 50, 59-62, 68` — asserts the slug list, the
  panel slug `issue-triage` (twice, once via the API key), and `pinned[0]`'s slug, weight
  and `required`.
- `scripts/seed-judges.test.ts:37-44, 54-66, 90-94, 160-163, 191-193` — judge count, model
  assignment, the `MODEL_VARS` subset assertion that becomes an equality again at P2, and
  the two variable-resolution tests P1 re-pointed at `SEED_MODEL_A`. The deleted test *"the
  three variables pin four judges across three labs"* returns here — that is the recorded
  coverage debt.

**The request shape (D4) — already built, contrary to the research doc's framing**
- `packages/contracts/src/evaluate.ts:81-90` — `context` is an optional
  `Record<string,string>` on `EvaluateRequest`, with a description and example, since M1.
- `apps/api/src/services/evaluate.ts:107, 353` — passed through to the judge call and
  persisted on the trace row.
- `apps/api/src/llm/openrouter-provider.ts:88-108` — rendered into the user message as a
  `Context:` block between the question and the artifact.
- `apps/api/src/llm/fake-provider.ts:53-59` — folded into the hash, key-order-normalised.
  **So P2 does not wire `context`; it becomes the first thing to *use* it** — the seeded
  request fixture, the README curl and the k6 body gain a `context` object.

**Constraints on what a judge may be**
- `docs/adr/0036-a-judge-must-gate-not-inform.md` — the second bar, and the worked example
  of moving a failing candidate across the line by putting the caller's own determination
  into `context`. Every candidate judge is checked against this, not only against polarity.
- `docs/CONVENTIONS.md:53-57` — one binary question per judge; never a bundled
  multi-criteria prompt. This is what forbids a single "reads as AI-written" judge (D6).
- `apps/api/src/services/evaluate.ts:129-192` — the scoring rule the weights are chosen
  against: `share` is normalised over the judges that *ran*, a `required` judge is a veto on
  any non-`evaluated` status or a `false` pass, and `passed = requiredHeld && score >= threshold`.
- `packages/contracts/src/evaluate.ts:92-130` — `judgeOutputSchema`; field order
  (`rationale` → `reasons` → `verdict` → `confidence`) is load-bearing, and
  `RATIONALE_TARGET_LENGTH`/`RATIONALE_MAX_LENGTH` bound what a question can reasonably ask for.
- `apps/api/src/llm/openrouter-provider.ts:80-87` — the prompt envelope is deliberately
  almost empty: **the judge's rubric IS its `question` string**, so question wording is the
  entire authoring surface until ADR-0032/0033 add `prompt`/`template` at M4.
- `apps/api/src/services/evaluate.ts:73-90` — `code` judges report `failed` until M5, so
  every seeded judge is `type: 'llm'` however deterministic it looks (D6's formatting tells).

**Prose that P2 touches vs. what P3 owns**
- `README.md:513-531` (seeded-panel section and its curl), `:558-562` (the failure-probe
  helper), `:635-638` (pinned-endpoint table), `:684-688` (span tree) — all describe the
  four M0 judges. The *shape* changes here (a `context` object in the body); the persona and
  polarity prose is P3.
- `docs/PRODUCT.md:27` (triage persona), `:165` (500 traces), `:171` (dogfooding
  commitment) and `docs/CONVENTIONS.md:61-69` (still states three-valued polarity) are P3 —
  but CONVENTIONS is the document P2 authors judges *against*, so its staleness is a
  reading hazard for the next session, not just a cleanup item.

**Named so they are not churned**
- `apps/api/src/routes/public/v1/evaluate.test.ts:96, 109, 296-378` and
  `apps/api/src/routes/internal/index.test.ts:90` use `issue-triage`/`needs-human` as
  hand-built route fixtures unrelated to the seed. They are already valid under ADR-0034 and
  need no change; `docs/adr/0019-panel-of-judges.md:78` cites `needs-human` as its veto
  example and is an accepted historical record, so no ADR edit is owed.

## Existing patterns and constraints that apply

- **Both bars, per candidate** (ADR-0034 + ADR-0036). "Is it a failure mode?" does not
  answer bar 2 — `needs-human` is a real failure mode of a triage bot and still wrong for us.
- **The bar for a seeded judge is not the bar for a real judge** (D5): they must be
  *precisely disagreeable*, not correct, and the seed's comments must say they are
  placeholders — the M0 four were mistaken for a product capability.
- **Taxonomy-blind first pass** (PRODUCT step 5, D7). Judges are the *output* of open coding
  over ~20 drafts, not a candidate list run against them; showing categories first anchors
  the expert. This is why the pass cannot be shortcut by drafting eight judges and pruning.
- **`context` is load-bearing, not decorative** (D4/D11): with a mixed corpus of email, Slack
  and long documents, "too formal" flips sign between a Slack reply to a teammate and a
  client email, so `context` must name channel and recipient or half the panel is
  undecidable.
- **The fake provider hashes `(model, question, artifact, sorted context)`.** Verdicts move
  whenever question wording moves, so the README's example artifact and the k6 body are
  chosen **after** seeding, by running the panel — never guessed. Both are downstream of the
  final question strings.
- **Immutable versions, idempotent seed** (ADR-0003): a `jdv_` is frozen and re-runs are
  `ON CONFLICT DO NOTHING`, so P2's judges are new rows and stale databases are wiped, not
  corrected.
- **Seed ids must be Crockford base32** without I/L/O/U and are asserted by `seedId`.
- **One branch and PR per phase** (CLAUDE.md): `feat/m5-p2-voice-panel`.
- **Do not pre-shape for ADR-0032/0033.** They add `prompt` and `template` to
  `judge_versions` at M4; the seed is rewritten again then regardless.

## Open questions for the human

1. **Which four judges — and the open-coding pass that produces them.** This is the whole
   gate, and it has not started: no corpus, notes or clusters exist anywhere in the repo.
   It needs no code and no panel (D7). Until it runs, P2 cannot be planned, only inventoried.
2. **Which drafts become public fixtures.** The corpus is the author's own writing and the
   repository is public (D8/D11). The README example artifact and the k6 body are committed
   text, so this is decided at P2, not deferred to M8.
3. **Seed identity: does the panel keep `pnl_000000000000000000SEEDPANE`?** The README curl,
   the failure-probe helper and k6's default all hard-code it. Keeping the id with a new
   slug is cheapest and relies on `down -v`; a new id is honest about it being a different
   panel and costs edits in four committed places.
4. **Four judges over three model variables — which one takes the veto, and on which lab?**
   The M0 assignment put the `required` veto on the strongest model so the veto path and the
   cheap path were visibly different models in one trace (decisions-log 2026-08-29). Whether
   that still holds when the axis is voice rather than triage is a judgement call.
5. **Does P2 or P3 rewrite PRODUCT §3's triage persona and §8's dogfooding commitment?**
   P3 owns prose, but §8 is the *justification* for the panel P2 authors, and a PR that
   ships a voice panel while PRODUCT still commits to judging GitHub issues reads as an
   accident rather than a decision.

## Recommended approach (input to planning, not the plan)

**Do the open-coding pass first, as its own artifact, before any P2 plan exists.** Collect
roughly twenty AI-generated drafts across email, Slack and longer documents; write free-text
notes on what is wrong with each; then cluster the notes into four categories and check each
against both bars. Land it as `thoughts/shared/research/<date>_voice-open-coding.md` — it is
the project's first real open-coding notes and material for M5, M6 and the public writeup,
not just an input to a seed script.

Then P2 is one branch, and its order matters: author the four judges and their questions
first, re-map `MODEL_VARS`, choose weights and threshold against the veto rule in
`evaluate.ts:129-192`, seed, and only then run the panel to pick the README and k6 artifacts
— because the fake provider's verdicts are a hash of the final question text. Update all
four places the judge set is written down in the same commit (`seed-judges.ts`,
`relations.test.ts`, `seed-judges.test.ts`, `infra/k6/smoke.js`), restore the deleted
three-labs test, and add `context` to the seeded request fixture, the README curl and the
k6 body. Leave the prose sweep to P3, with question 5 settled before the PR is opened.
