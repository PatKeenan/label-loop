# Mockup Brief — Phase A: PARTIALLY RESUMED for the console frame (M4)

**Status:** paused 2026-08-20; **partially resumed 2026-09-11** (ADR-0055) for exactly three
artifacts. Everything else in this file below the next section is the record of the pause,
and still holds.

## The M4 resume — three artifacts, in this order

Plan: `thoughts/shared/plans/complete/2026-09-11_m4-console-auth.md`, phase 6. Each is
reviewed and approved before the next is drawn, because each is drawn from the one before.

1. [x] **`CONSOLE_FLOW.md`** — *approved 2026-09-14.* The flow map. Every console screen
   M4 → M8, its milestone, its entry point and its scope; screens that do not exist are
   marked as such. Not a design.
2. [x] **`console-shell.html`** — *r2 approved 2026-09-15.* The frame, redrawn after the first review. A persistent left
   sidebar (ADR-0056, amended 2026-09-14) with two levels: Home and a panel, "← Home" out of
   a panel, a **panel** switcher (the harvest's "classifier switcher", renamed by ADR-0019)
   whose sections are always that panel's, and at the foot identity, the organisation, and
   admin-only settings that appear at M8 (ADR-0059). Plus the modal slot and three error
   surfaces. Phase 7 builds it, so phases 7–8 are blocked on its approval.
3. [x] **`panel-create.html`** — *r3 approved 2026-09-15.* No longer a wizard:
   creating a panel is **one step** (name, slug, threshold), and the panel's own **Overview** is
   the onboarding screen — collecting state, progress toward the 50-trace annotation gate, and a
   copyable curl / Node / Python snippet carrying the key issued with the panel. Judge authoring
   is **locked behind an eval pass** (ADR-0061) and moves to M6; the measured model picker
   survives in the file as an explicitly-marked M6 reference.

**Why the resume is this narrow.** Drawing the wizard alone would have let one screen invent
the app shell; drawing every screen would repeat what paused Phase A. `annotator-session` and
`console-dashboard` stay paused, and the six blockers at the bottom of this file stay open —
none of them gates these three.

## The M5 resume — one screen (ADR-0071)

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md`, phase 3.

4. [x] **`annotator-session.html`** — *r6 drawn AND APPROVED 2026-09-20; r7 2026-09-21, wording only.*
   r5 (2026-09-18) redrew it for judgeless panels: *acceptable / not acceptable* with a
   required note (ADR-0066), no operator signals (ADR-0067), the `/annotate` landing listing
   every panel with its progress toward 50, and centred "nothing open yet" and "all caught up"
   states. **r6 redraws the trace itself for ADR-0073**, which landed between r5 and its review
   (#77–#81): the IN/OUT pair becomes ONE FLOW IN TIME ORDER — reference collapsed, turns
   labelled User and Agent, tool calls as single lines outside the annotated turn, and the violet
   surface on the final reply alone — the same rules the console now renders by
   (`apps/web/src/components/shaped/`). Metadata is absent entirely (ADR-0077). A sixth state
   draws a LEGACY trace, whose input was never recorded (ADR-0074). Q1 (IN/OUT for the triage
   persona) is CLOSED by the four roles; Q5 (long outputs) and a new Q6 (should an annotator see
   tool steps at all) are the open ones.
   **r7 (2026-09-21) is the same screen with the word corrected** (ADR-0085: the product says
   annotation, not review). No layout change, no new open question; r6's approval stands.
   Served for review by the `mockups` launch configuration (`http://localhost:5500`), because
   the preview pane renders a bare file without `tokens.css`.

`console-dashboard` stays paused.

---

# The pause, as recorded on 2026-08-20

The project was backend-first (M0 → M1); the first milestone then expected to need a
designed screen was **M5** (annotator surface). This part is a record of what Phase A settled
and what it left open — not a work queue.

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
   *Brought forward to M4 by ADR-0055 — see the top of this file.*

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
