# Mockup Brief — Phase A: PAUSED (record)

**Status:** paused 2026-08-20. The project is backend-first (M0 → M1); the first
milestone that needs a designed screen is **M5** (annotator surface). This file is now a
record of what Phase A settled and what it left open — not a work queue.

Full design rationale, extracted verbatim from the screen files before they were deleted:
**`thoughts/shared/research/2026-08-20_phase-a-design-harvest.md`**. That document also
lists where the mockups CONTRADICT or OUTRUN PRODUCT.md, which is the part needing human
decisions before Phase A resumes.

## What Phase A produced

- [x] **`tokens.css` — APPROVED 2026-08-19.** Direction: **Instrument** — chrome is
      achromatic, colour is data. Annotator and console are one palette on two axes
      (`data-tone`, `data-density`) with `data-surface` presets. Render check:
      `tokens-preview.html`. Both files are retained; Phase C consumes them.
- Four screens drafted and reviewed (`annotator-session` r4, `annotator-home` r1
      rejected, `console-trace-explorer`, `console-eval-round` proposal). The HTML is
      deleted; the decisions are in the harvest doc and in git history.

## Rules (unchanged, for when this resumes)
- Plain HTML + CSS, no frameworks or build step. Every screen imports `tokens.css`.
- Realistic fake data. Lorem ipsum hides UX problems.
- Header comment per file: screen name, role, PRODUCT.md section, open questions.
  *(This convention is why Phase A survived deletion — keep it.)*
- Mockups are disposable spec — never ported into the app (CLAUDE.md Phase C).

## Scope when Phase A resumes (M5+)
Three load-bearing screens only. Everything else ships as an unstyled table until a
milestone demands better.

1. `annotator-session.html` (P0) — one trace at a time, agree/correct, failure note,
   session goal. The product thesis. [PRODUCT.md 5.5]
2. `console-dashboard.html` (P0) — quality by judge version, judge-vs-human
   agreement, cost per call frontier vs fine-tune. The receipts. [5.10]
3. `panel-create.html` (P1) — wizard: name, judges, prompt/context, model →
   version 1 + API key reveal (shown once). The interviewer's entry point. [5.2, 5.1]

## Deferred (unstyled until a milestone demands better)
Trace explorer · taxonomy builder · fine-tune unlock and results · alignment session
(arbiter surface — its output is a revised rubric, not a pile of resolved items) ·
judge alignment (the judge-vs-human confusion matrix) · guest-expert invite · billing
(Stripe-hosted where possible) · audit log viewer · annotator home/gamification.

## Blocking Phase A's resumption — product decisions, not design ones
These sit in the harvest doc with full reasoning. Each needs a human call:

1. **Consensus-free scoring.** PRODUCT.md 5.5 weights points by consensus alignment;
   the mockups state on-screen that consensus never affects an annotator's score. Direct
   contradiction.
2. **Confidence withheld from annotators.** An eval-integrity rule (automation bias is
   asymmetric and inflates agreement), currently written nowhere in PRODUCT.md.
3. **The annotation-round object.** Frozen, versioned set of traces + annotations +
   config versions. Proposed by `console-eval-round`; PRODUCT.md has no such concept.
4. **Judge validation metrics.** PRODUCT.md 5.7 specifies none. Candidate: per-label
   TPR/TNR against an 80% bar, with Rogan–Gladen correction on unlabelled traffic.
5. **Arbiter / overlap / split / alignment session.** Cited by the mockups as
   "PRODUCT.md 5.5" but absent from it.
6. Smaller: confidence band thresholds (0.85/0.60 placeholders), licensed type pair,
   levels vs streaks, trace-explorer column count.
