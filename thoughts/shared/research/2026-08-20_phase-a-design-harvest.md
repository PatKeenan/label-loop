---
date: 2026-08-21T02:05:00Z
author: claude-code
status: complete
milestone: M5
topic: phase-a-design-harvest
related_adrs: []
---

# Phase A design harvest — rationale rescued from the mockups

## Why this doc exists
Phase A is paused: the project is backend-first (M0 → M1), and the first milestone that
needs a designed screen is M5. The mockup HTML is disposable by rule (CLAUDE.md Phase C:
"Mockups are disposable spec, never scaffold"), but the *reasoning* inside those files is
not — roughly 400 lines of design and product decisions live in their comment headers,
several of which resolve questions PRODUCT.md has not yet asked.

This document preserves every comment block verbatim so the HTML can be deleted without
losing the thinking. Sequencing: this harvest lands first, everything is committed as-is
at `git init`, and the screen files are deleted in a following commit — so the history
keeps them permanently and the working tree stays clean.

`mockups/tokens.css` and `mockups/tokens-preview.html` are NOT deleted. tokens.css is the
approved, locked style guide (BRIEF.md, approved 2026-08-19) and Phase C consumes it.

## What survives, what goes

| Artifact | Disposition |
|---|---|
| `mockups/tokens.css` | **Kept** — approved style guide, consumed by Phase C |
| `mockups/tokens-preview.html` | **Kept** — the render check that made approval possible |
| `annotator-session.html` | Rationale harvested below → file deleted after first commit |
| `annotator-home.html` | Rationale harvested below → file deleted after first commit |
| `console-trace-explorer.html` | Rationale harvested below → file deleted after first commit |
| `console-eval-round.html` | Rationale harvested below → file deleted after first commit |
| `labelloop-latest/` | Deleted — stray duplicate holding only BRIEF v2 and a `.DS_Store` |

## How to read this
Everything below the divider is verbatim extraction, unedited. The analysis of where these
decisions CONTRADICT or OUTRUN PRODUCT.md is in the final section, and that section is the
one that needs a human decision.

---

## tokens.css preview

**Status:** APPROVED 2026-08-19 — the locked style guide · **Source:** `mockups/tokens-preview.html` (13 comment blocks)

### Header

```
  SCREEN: tokens-preview
  ROLE:   stakeholder review only — not a product screen, never ported.
  IMPLEMENTS: mockups/BRIEF.md "Create tokens.css FIRST and get it approved".
  PURPOSE: render every token in tokens.css so it can be judged in a browser.
  NOTE:   this page carries its own presentational CSS because tokens.css is
          custom-properties-only. Every value below resolves from a token —
          if something looks wrong here, the fix belongs in tokens.css.
  OPEN QUESTIONS:
   - Confidence band thresholds (0.85 / 0.60) are placeholders; product call.
   - Licensed type pair not yet chosen; system stacks stand in.
```

### Inline note 1

```
 ============================ 1. PRIMITIVES ============================
```

### Inline note 2

```
 ======================= 2. STRUCTURE SEMANTICS ========================
```

### Inline note 3

```
 ==================== 3. CLASSIFICATION STATES =========================
```

### Inline note 4

```
 ================== 4. JUDGE + CONFIDENCE + AUTHORSHIP =================
```

### Inline note 5

```
 ========================= 5. TYPE ROLES ===============================
```

### Inline note 6

```
 ======================== 6. SPACING SCALE =============================
```

### Inline note 7

```
 ==================== 7. RADII / BORDERS / SHADOWS =====================
```

### Inline note 8

```
 ================= 8. THE TWO SURFACES, SAME COMPONENTS ================
```

### Inline note 9

```
 ANNOTATOR
```

### Inline note 10

```
 CONSOLE
```

### Inline note 11

```
 ========================== 9. CHART TOKENS ============================
```

### Inline note 12

```
 ============================ 10. RULES ===============================
```

---

## annotator-session

**Status:** P0, r4 — the product thesis screen · **Source:** `mockups/annotator-session.html` (6 comment blocks)

### Header

```
  ============================================================================
  SCREEN:     annotator-session
  ROLE:       annotator (non-engineer SME); also guest expert, PII-masked
  IMPLEMENTS: PRODUCT.md 5.5 (role-adaptive surfaces, sampling, calibrated
              gamification), 5.4 (traces are the reviewed object),
              feeds 5.6 (axial coding needs the free-text notes)
  SURFACE:    data-surface="annotator" — light + comfortable. One trace, one
              question, no JSON, no nav sprawl.
  REVISION:   r2 — (a) input/output matched weight, (b) note REQUIRED on a
              correction and capped, (c) Skip added, with its own queue.
              r3 — exchange restacked with explicit IN/OUT roles and a
              connector; shell widened so the action row holds one line.
              r4 — all confidence signalling removed from this surface.
  ============================================================================

  WHY THERE IS JAVASCRIPT HERE (BRIEF.md allows it "if a flow is meaningless
  without it"). Three behaviours on this screen are decisions, not decoration,
  and cannot be judged from a static picture: the correction branch revealing
  itself, the note gating Save, and the character cap biting. ~60 lines, no
  dependencies, no build step. It exists to make the flow reviewable, and it
  is disposable with the rest of the mockup.

  DECISIONS ENCODED HERE (the point of the screen — reject these, not the CSS)

  1. INPUT AND OUTPUT ARE WEIGHTED EQUALLY, AND LABELLED AS SUCH. The
     annotator is judging a PAIR — "does this output match this input" — so
     both carry a header bar, a role badge (IN / OUT), matched padding, and
     the answer is set at display size. A connector between them makes the
     direction literal.

     Stacked, NOT side by side: the input runs long and the output is one
     word, so matched columns force the answer panel to stretch and open a
     void. Equal PRESENCE is the goal, not equal area. And the roles are
     carried by badges rather than by a small caption — an eyebrow alone
     reads as generic product chrome, not as "this is the output". [r3]

  2. THE TWO VERDICTS CARRY EQUAL WEIGHT UNTIL ONE IS CHOSEN. Neither "Yes"
     nor "No" is styled as the primary action. A dominant "Yes, that's right"
     is a nudge toward agreement, and agreement is exactly what this screen
     must not manufacture. A button fills when SELECTED, never by default. [r2]

  3. NO CONFIDENCE SIGNAL AT ALL — NOT A NUMBER, NOT A HEDGE, NOT A WORD. [r4]
     Earlier revisions showed "it wasn't very sure". That was wrong twice over:

     (a) Automation bias is ASYMMETRIC. High confidence suppresses challenge
         far more than low confidence invites it, so exposing confidence does
         not add symmetric noise — it systematically inflates agreement. And
         judge-vs-human agreement is the headline metric this product exists
         to measure honestly. A UI that inflates it corrupts the number.
     (b) It contradicted decision 4. Announcing low confidence tells the
         annotator this item came from the low-confidence sampler — exactly
         the sampling leak decision 4 exists to prevent.

     Moving it outside the card does not help: visibility is the contaminant,
     not placement. And the annotator can do nothing with it — they must read
     the issue and decide either way. Confidence is operator information.
     It stays in the console, the trace, and the audit record.

  4. THE ANNOTATOR IS NEVER TOLD WHY THIS ITEM IS REALLY HERE. No honeypot
     badge, no "the judge disagreed", no "this is a re-serve consistency
     check". Marking any of those destroys the signal it exists to collect.
     The "why am I seeing this" line is deliberately generic enough to be
     true for every sampling strategy (PRODUCT.md 5.5).

  5. THE JUDGE'S VERDICT IS WITHHELD UNTIL AFTER SUBMIT. Showing it first
     anchors the human, and judge-vs-human agreement stops meaning anything.

  6. A CORRECTION MUST CARRY A REASON; AGREEING NEED NOT. Disagreement is the
     expensive signal — it is what axial coding (5.6) clusters into the failure
     taxonomy, and an uncommented correction is a data point we cannot learn
     from. Agreement is cheap and needs no justification. Save stays disabled
     until a corrected item has both a label and a note. [r2]

  7. THE NOTE IS CAPPED, NOT COAXED. 280 characters, hard maxlength, live
     counter. Asking politely for brevity in placeholder text does not produce
     brevity; a cap does. Short notes also cluster far better than essays. [r2]

  8. SKIPPING IS A FIRST-CLASS ANSWER, AND IT IS FREE. An SME who cannot tell
     will otherwise guess, and a guess is worse than an abstention — it is
     noise entering the training set wearing a human's authority. Skip takes
     one key, needs no justification, and is stated on-screen not to affect
     the annotator's score. Skipped items leave this queue and go to the
     review queue; they never silently return to the person who skipped. [r2]

  9. SKIP RATE IS ITSELF A MEASUREMENT. An item several annotators skip is
     evidence that the label definitions are ambiguous, or that the item is
     genuinely `needs-human`. That belongs in the taxonomy (5.6), not in a
     dead-letter queue. Console-side surfacing is not drawn here. [r2]

 10. SCORING HONESTY IS ON THE SCREEN. The footer states that accuracy — not
     volume or speed — drives the score, that known-answer checks are mixed
     in, and that skipping costs nothing. Disclosing that the checks exist
     (without marking which items they are) is the Goodhart-aware position.

 11. KEYBOARD-FIRST. Y / N / S, 1-4, Enter. An SME doing 20 of these should
     never need the mouse. (Swipe equivalents: mobile, not drawn here.)

 12. NO COST, LATENCY, MODEL NAME, OR TRACE ID ANYWHERE. If an engineer
     wants those, they are in the console. (Confidence: see decision 3.)

  OPEN QUESTIONS FOR REVIEW
  - Q1. "Blind mode": should a sampling strategy exist that hides the proposed
        label until the annotator commits to their own? Kills anchoring, costs
        speed. Candidate as a per-classifier setting, not a global default.
  - Q2. Is disclosing that known-answer checks exist (footer) right, or does it
        make SMEs feel surveilled? Alternative is silence, which reads worse if
        they ever find out.
  - Q3. [RESOLVED r4 — confidence is not shown to the annotator at all.]
        Superseded by Q9.
  - Q4. Is 280 characters the right cap? Long enough for a real reason, short
        enough to cluster. Untested.
  - Q5. Token gap: --judge-owned-* is named for the judge, but the mark here is
        the CLASSIFIER's proposed label. Same violet, narrower name. Consider
        renaming to --machine-owned-* in tokens.css. Using --state-info-* for
        now rather than editing a locked file.
  - Q6. WHO drains the skipped queue? Options: higher-reliability annotators
        only; the engineer; or it becomes multi-annotator consensus work. This
        is a routing decision with a schema consequence — skipped items need an
        annotator_id and a reason-less skip event in the audit log either way.
  - Q7. Should a skip ever be allowed to carry an optional one-line "why"? It
        would be useful taxonomy input, but any friction on skip pushes people
        back toward guessing. Currently frictionless on purpose.
  - Q8. Does an annotator see their own skipped items again once someone else
        resolves them? Good for learning, bad for queue purity.
  - Q9. POST-SUBMIT REVEAL. Confidence cannot anchor a decision that is already
        recorded. So: after Save, do we show "our system was 61% sure — and the
        judge agreed with you"? It turns a contaminant into a calibration and
        engagement signal, and it is consistent with decision 5 (the judge
        verdict is already withheld until after submit). Costs a screen state
        and risks turning the session into a scoreboard. Not built. [r4]

  NOT DRAWN (deliberate): sign-out, settings, help, notifications, any nav to
  other classifiers. This surface has one job.
```

### Inline note 1

```
 Minimal chrome. No nav, no settings, no notifications.
```

### Inline note 2

```
 Generic on purpose: must read identically for a random item, a
           low-confidence item, a judge-disagreement item, and a honeypot.
```

### Inline note 3

```
 [r2] Matched panels. The annotator is judging the pair, so the pair
           is presented as a pair.
```

### Inline note 4

```
 Revealed by "No". Static reviewers: set hidden="" to false to see it.
```

### Inline note 5

```
 Calibrated gamification, stated plainly (PRODUCT.md 5.5, STAKEHOLDER
         VALUE cat. 2): the score rewards being right, not being fast, and
         abstaining is free.
```

---

## annotator-home

**Status:** DEFERRED — r1 rejected 2026-08-19 · **Source:** `mockups/annotator-home.html` (5 comment blocks)

### Header

```
  ============================================================================
  SCREEN:     annotator-home
  ROLE:       annotator (non-engineer SME); also guest expert
  IMPLEMENTS: PRODUCT.md 5.5 — calibrated gamification, consensus-free scoring,
              annotator reliability inputs, queue status, single-SME fallback
  SURFACE:    data-surface="annotator" — light + comfortable
  STATUS:     DEFERRED — r1 rejected 2026-08-19. Do not build on this file.
              Rebuild after the console establishes an app shell: this screen
              needs to feel like logging into a dashboard (persistent side
              panel, app chrome), and the accuracy-section vocabulary needs
              reworking before the layout is worth revisiting. Kept only as a
              record of the scoring-model decisions below, several of which
              are still good even though the screen is not.
  ============================================================================

  THE BRIEF SAID "FRIENDLY, NOT CHILDISH". That line is doing real work, so
  here is what it ruled out: no badges, no confetti, no mascot, no percentile
  ranking against colleagues, no progress bar toward a trophy. What is left is
  plain numbers, plain sentences, and one clear next action. An SME with
  twenty years of domain expertise is being asked to do careful work; the
  screen should read like it respects that.

  DECISIONS ENCODED HERE

  1. THE SCORE PANEL SHOWS ITS SOURCES, NOT A SINGLE NUMBER. Three separate
     measurements — check items, reviewer alignment, self-consistency — each
     shown as a raw fraction. Collapsing them into one "reliability: 87" would
     hide that they mean different things, and would invite optimising the
     composite. The composite exists (it weights training labels) but is NOT
     shown, because a visible weight is a gameable weight.

  2. THE SCREEN STATES WHAT DOES *NOT* AFFECT THE SCORE. "Agreeing with other
     annotators is never part of your score" is written on the surface, because
     the whole point of consensus-free scoring (PRODUCT.md 5.5) is that a lone
     expert can hold their position without cost. A rule nobody is told about
     cannot do that job.

  3. AGGREGATE STATS ARE SAFE; PENDING ITEMS ARE NOT. Showing "47 of 50 check
     items correct" is history and cannot anchor a decision. It never reveals
     WHICH upcoming items are checks. This is the same rule as the session
     screen, applied at a different tense.

  4. COLOUR APPEARS ONLY WHEN SOMETHING NEEDS ATTENTION. Personal numbers are
     achromatic. A stat takes the warning token only when it drops below its
     threshold. A screen full of green ticks is a screen that has stopped
     conveying anything — and colouring someone's own accuracy green/red by
     default reads as judgement rather than measurement.

  5. NO LEVELS. PRODUCT.md 5.5 says "streaks/levels". Streaks survived —
     they reward rhythm, and rhythm is what keeps annotation habitual. Levels
     did not: every level system is fundamentally an accumulation counter, so
     it rewards volume, which is the exact thing calibrated gamification
     exists to stop rewarding. Flagged as Q4 rather than silently dropped.

  6. THE SKIPPED QUEUE IS VISIBLE AND EXPLAINED. An annotator who skips needs
     to see that the item went somewhere, or skipping feels like discarding
     work. It never returns to them (session screen, decision 8).

  7. SINGLE-SME TENANTS: the "matched the reviewer" row is absent, not empty.
     With one SME there is no arbiter alignment to report, and an empty panel
     advertises a feature the tenant does not have (PRODUCT.md 5.5).

  OPEN QUESTIONS FOR REVIEW
  - Q1. Should the annotator see their own reliability WEIGHT (the number that
        scales their labels during training)? Currently no — visible weights
        get optimised, and it is a model artefact rather than feedback. But
        hiding it sits awkwardly with the contribution-ledger transparency the
        royalties vision promises (PRODUCT.md 10).
  - Q2. "Check items" is my plain-language name for honeypots. It discloses
        that they exist without naming which. Better word?
  - Q3. Is showing all-time volume ("1,284 reviewed") a volume incentive by
        the back door? It is the only number here that rewards quantity.
  - Q4. Levels: dropped for the reason in decision 5. Overrule if the
        engagement argument beats the Goodhart argument.
  - Q5. Weekly bars show items per day. Should a day with 3 careful
        corrections look smaller than a day with 12 quick agreements? Right
        now it does, which mildly contradicts accuracy-over-volume.
  - Q6. Nothing here shows an annotator what happened to items they got wrong.
        A "what you missed" review would be the strongest calibration tool on
        the platform — and the most likely to feel like surveillance.

  NOT DRAWN (deliberate): leaderboards (opt-in per org, off by default —
  PRODUCT.md 5.5), payouts/contribution ledger (V1 designs the schema only),
  any navigation to other people's stats.
```

### Inline note 1

```
 The screen has one job: get them into the session.
```

### Inline note 2

```
 The honest scoring panel: sources, not a composite.
```

### Inline note 3

```
 Absent, not empty, for single-SME tenants (decision 7).
```

### Inline note 4

```
 Rhythm, not volume worship.
```

---

## console-trace-explorer

**Status:** drafted, unreviewed · **Source:** `mockups/console-trace-explorer.html` (5 comment blocks)

### Header

```
  ============================================================================
  SCREEN:     console-trace-explorer
  ROLE:       engineer / admin
  IMPLEMENTS: PRODUCT.md 5.4 (trace capture + explorer with filtering),
              5.5 (sampling strategies, overlap assignment), 5.7 (judge)
  SURFACE:    data-surface="console" — dark + compact. First screen to
              exercise the console half of tokens.css on real dense data.
  ============================================================================

  DECISIONS ENCODED HERE

  1. THIS SCREEN IS THE COMPLEMENT OF THE ANNOTATOR SURFACE. Everything
     deliberately withheld from the SME lives here in full: confidence to two
     decimals, cost, latency, token counts, model version, trace id, sampling
     reason, honeypot status. Same data, opposite disclosure rule — because
     the engineer is debugging the system and the SME is judging the content.

  2. THE APP SHELL LIVES HERE. Persistent left rail with the classifier
     switcher, section nav, and saved views. The annotator surface has no
     shell by design; the console is where an engineer navigates.

  3. FILTERS ARE THE SAMPLING STRATEGIES. Every filter on this screen maps to
     a sampling strategy in 5.5 — low confidence, judge disagreement, honeypot,
     unreviewed. That is why a filter can be saved as a view AND pushed into
     an annotation queue: "the traces I am looking at" and "the traces worth
     human time" are the same question asked twice. The bulk action carries
     the overlap setting (how many annotators), so assignment happens where
     the evidence is, not in a settings page.

  4. JUDGE AND HUMAN ARE SEPARATE COLUMNS; AGREEMENT IS DERIVED. Merging them
     into one "verdict" column would hide which of the two moved when they
     diverge — the whole point of tracking drift. Agreement is a mark, never
     a merged label.

  5. RAW PAYLOADS EXPAND; THEY DO NOT LIVE IN THE ROW. An engineer needs the
     exact request and response, but JSON in a table destroys the scanning
     that makes a table worth having. One row is drawn expanded to show the
     state; no JS (BRIEF rule) — the built screen toggles it.

  6. MONEY, LATENCY, TOKENS AND IDS ARE MONO AND ACHROMATIC (tokens.css rule
     4). Colour on this screen means: confidence band, judge verdict, honeypot,
     or authorship. Nothing else. A dense table is exactly where a decorative
     hue would do the most damage.

  7. COLOUR ONLY WHERE IT VARIES. The `label` column is plain text even though
     it is machine-authored, because every row in it is — a uniformly violet
     column spends the authorship signal without distinguishing anything.
     Violet is reserved for cells where authorship genuinely differs. Human
     labels are graphite. What is left carrying colour in this table:
     confidence band, judge verdict, split, pending, honeypot. Nothing else.

  8. OVERLAP IS VISIBLE IN THE HUMAN COLUMN. Now that a trace can carry more
     than one human label (PRODUCT.md 5.5), the column shows the count and
     whether they split — "bug x2" versus a "split" mark. See Q2.

  OPEN QUESTIONS FOR REVIEW
  - Q1. Column set is 10 wide and will not survive a laptop viewport without
        horizontal scroll. Options: a column picker, a responsive drop order,
        or accept the scroll. Currently accepting the scroll, which is honest
        for a data console but the least designed answer.
  - Q2. How should a split human verdict render in one row? Right now: a
        "split" mark plus the count, with the individual labels only in the
        expanded payload. Alternative is stacked mini-marks per annotator,
        which is more informative and much noisier.
  - Q3. Should the sampling reason (why this trace was surfaced for review) be
        a column or a filter only? It is currently a filter and an expanded-row
        field. As a column it would be the 11th.
  - Q4. Bulk "send to annotation queue" sets overlap at assignment time. Should
        it instead inherit the classifier's annotation policy by default, and
        only allow an override here? Probably yes — two places to set the same
        number is how they drift apart.
  - Q5. Honeypot rows are marked here. That is safe (engineers may know) but it
        means anyone with console access can learn the answer key. Does the
        arbiter role need console access restricted, or is that paranoia?
  - Q6. Time column is relative ("14m"). Absolute timestamps matter for audit
        correlation. Hover title, a toggle, or an absolute column?

  NOT DRAWN: pagination controls beyond the count, column sorting affordances,
  the trace detail full-page view (this is the list, not the record).
```

### Inline note 1

```
 ============ APP SHELL ============
```

### Inline note 2

```
 ============ MAIN ============
```

### Inline note 3

```
 Filters ARE the sampling strategies (decision 3).
```

### Inline note 4

```
 One row drawn expanded to spec the payload state (decision 5).
```

---

## console-eval-round

**Status:** PROPOSAL — concept not yet in PRODUCT.md · **Source:** `mockups/console-eval-round.html` (4 comment blocks)

### Header

```
  ============================================================================
  SCREEN:     console-eval-round                              *** PROPOSAL ***
  ROLE:       engineer / admin (the developer's entry into the eval loop)
  STATUS:     NOT YET IN PRODUCT.md. This screen is being used as the spec for
              a concept the product document does not currently contain — the
              annotation round as a frozen, versioned object. Reviewed first,
              written into PRODUCT.md second, by explicit instruction.
  IMPLEMENTS: would extend 5.5 (agreement), 5.6 (axial coding), 5.10
              (dashboards); depends on nothing that does not already exist
              except the round object itself.
  SURFACE:    data-surface="console" — dark + compact
  ============================================================================

  WHAT THIS SCREEN IS FOR
  The trace explorer answers "show me traces matching X". It cannot answer
  "what is systematically wrong", because that is an aggregate question over a
  fixed set. This is that screen: a closed round of SME annotation, measured.
  It is the handover point where the SMEs' work becomes the developer's input
  — the "central spot" where the two roles actually meet.

  THE CONCEPT BEING PROPOSED

  1. A ROUND IS FROZEN AND VERSIONED. A saved filter is not a dataset: it
     re-runs and returns different rows tomorrow. Nothing can be measured or
     compared against a moving target, so "κ was 0.61 on this set" and "round 3
     beat round 2" both require the set to be immutable. A round pins its trace
     ids, its annotations, and the label/prompt/judge versions in force when it
     ran. This is what CLAUDE.md's immutable dataset-version rule is pointing
     at, one layer earlier than fine-tuning curation (5.8).

  2. THE CONFUSION MATRIX IS THE CENTREPIECE, NOT A CHART. For a classifier,
     it is the diagnostic that names the actual problem: not "accuracy is 80%"
     but "the model calls bugs questions, 27 times". A single confusable label
     PAIR is almost always the story, and the pair is what the arbiter revises
     definitions for. It appears nowhere in PRODUCT.md today.

  3. THE SME'S NOTES ARE ON THIS SCREEN, NOT JUST THEIR LABELS. The label is
     the cheap part of an annotation; the note is where the expertise is. A
     developer screen that shows the verdict and drops the reasoning wastes the
     scarcest input the product has. The notes panel is the on-ramp to axial
     coding (5.6) and the answer to "why did they disagree with us".

  4. AGREEMENT IS SHOWN PER LABEL, NEVER ONLY IN AGGREGATE. One bad label pair
     drags a whole-classifier κ down and hides where the damage is. The
     per-label table is what makes the number actionable.

  5. THE ROUND ENDS IN AN ACTION, NOT A REPORT. Every measurement on this
     screen routes somewhere: splits to the alignment session, notes to axial
     coding, confused pairs to the label definitions. A dashboard that only
     informs is the failure mode this screen is designed against.

  6. RAW AGREEMENT IS NEVER A HEADLINE; TPR AND TNR ARE. [r2, after Husain]
     Agreement is a trap metric under class imbalance — if a label is rare, a
     model (or judge) that never predicts it still scores well. The first draft
     of this screen led with "79.5% model matched human", which is exactly the
     number PRODUCT.md 5.5 already says must never be the headline. It is now a
     footnote under the matrix. The headline is how many labels fail the 80%
     TPR bar, and the per-label table carries TPR/TNR beside κ.

     needs-human is the case that proves the point: 97% TNR, 77% TPR. It almost
     never fires wrongly and misses a quarter of the cases that needed a
     person — invisible to any accuracy-style metric, and the most costly miss
     in the label set.

  7. COLOUR IS RESERVED FOR THE MATRIX AND THE VERDICTS. Counts, ids, costs,
     and κ values are mono and achromatic. In the matrix, intensity encodes
     magnitude — the one place on the screen where a value's SIZE is the
     finding rather than its identity.

  OPEN QUESTIONS — resolve these before this goes into PRODUCT.md
  - Q1. What closes a round? Manual ("close round"), a target count, a cadence
        (weekly), or a coverage threshold? Manual is drawn. Automatic rounds
        risk closing mid-disagreement.
  - Q2. Is a round scoped to one classifier, or can it span several? Drawn as
        one classifier, which is simpler and matches how label definitions are
        versioned.
  - Q3. Can a round be reopened? Currently no — reopening breaks immutability,
        and "round 4" is cheap. But late annotations then land nowhere.
  - Q4. Does the round own the traces, or reference them? Reference, with the
        annotation set frozen. A trace can appear in several rounds over time,
        which is what makes round-over-round comparison meaningful.
  - Q5. Is "round" the right word to a customer? Alternatives: eval run,
        annotation batch, review cycle. "Run" collides with judge runs.
  - Q6. Should the matrix be model-vs-human (drawn) or also offer
        judge-vs-human and annotator-vs-annotator? All three are real
        questions; three matrices on one screen is too many.
  - Q7. Where does this live in the nav — under Annotation, or its own
        section? Drawn as its own "Rounds" section.
  - Q8. THIS SCREEN MEASURES THE MODEL. The judge — the instrument that runs
        continuously against live traffic — needs the same treatment against
        human labels, plus TPR/TNR-based correction of its estimates on
        unlabelled traffic. That is a separate screen (console-judge-alignment,
        added to BRIEF.md) and a gap in PRODUCT.md 5.7, which currently
        specifies no metric for judge validation at all.
  - Q9. Round-over-round comparison is drawn as a single delta strip. It may
        deserve to be the whole of console-dashboard instead, with this screen
        staying inside one round.

  NOT DRAWN: the round list/index, matrix cell drill-through, the axial coding
  workspace itself (that is taxonomy-builder), significance testing on the
  round-over-round delta.
```

### Inline note 1

```
 The round as an object: frozen, versioned, pinned.
```

### Inline note 2

```
 THE CENTREPIECE
```

### Inline note 3

```
 The SMEs' reasoning, on the developer's screen.
```

---

# Analysis: where the mockups outran PRODUCT.md

The screens were drafted after PRODUCT.md and, in several places, decided things the
product document still does not say — or says differently. These are not design details;
they are product decisions sitting in HTML comments. Each needs a human call before it can
graduate into PRODUCT.md.

## 1. Consensus-free scoring — a direct contradiction
- **PRODUCT.md 5.5** says annotator points are "weighted by consensus alignment on
  multi-annotator items."
- **annotator-home decision 2** says the opposite, and says it on the screen: "Agreeing
  with other annotators is never part of your score," so a lone expert can hold their
  position without cost.

These cannot both be true. The mockup's position is the stronger one — consensus-weighted
scoring punishes the correct dissenter, which is precisely the expert you most want to
keep — but PRODUCT.md is the source of truth and currently says otherwise. **Needs a
decision.**

## 2. Confidence is withheld from annotators entirely
**annotator-session decision 3 [r4]** removes every confidence signal from the annotator
surface, on two grounds: automation bias is asymmetric (high confidence suppresses
challenge more than low confidence invites it, so exposure systematically *inflates*
agreement — corrupting the headline judge-vs-human metric), and naming low confidence
leaks which sampler the item came from.

PRODUCT.md does not state this rule anywhere. It is an eval-integrity constraint, not a
UI preference, and it belongs in 5.5 or 5.7.

## 3. The "annotation round" object does not exist in PRODUCT.md
**console-eval-round** proposes it explicitly and was drafted under instruction to be
reviewed first and written into PRODUCT.md second. A round is a frozen, versioned set:
pinned trace ids, pinned annotations, and the label/prompt/judge versions in force when it
ran — because "κ was 0.61 on this set" and "round 3 beat round 2" both require an immutable
target. This is CLAUDE.md's immutable dataset-version rule appearing one layer earlier than
fine-tune curation (5.8). **Still unwritten.**

## 4. TPR/TNR over raw agreement, under class imbalance
**console-eval-round decision 6 [r2]** demotes raw agreement to a footnote: it is a trap
metric when a label is rare, since a model that never predicts the rare label still scores
well. The headline becomes how many labels fail an 80% TPR bar, with per-label TPR/TNR
beside κ. BRIEF.md carries the matching judge-side spec — the Rogan–Gladen correction,
`corrected = (observed + TNR − 1) / (TPR + TNR − 1)`, flagged for verification against
Husain's validate-evaluator before being treated as spec.

**PRODUCT.md 5.7 specifies no judge-validation metric at all.** This is the largest gap:
the judge is the instrument that runs continuously against live traffic, so if it is
uncalibrated every downstream quality number is wrong.

## 5. Concepts referenced that PRODUCT.md does not define
The mockups repeatedly cite "PRODUCT.md 5.5" for things 5.5 does not contain: an **arbiter**
role, **overlap** (how many annotators per trace), **split** verdicts, and an **alignment
session** whose output is a revised rubric rather than a pile of resolved items. BRIEF.md
describes the alignment-session screen as "PRODUCT.md 5.5, added v0.2" — so either a 5.5
revision was drafted and lost, or the screens ran ahead. Either way PRODUCT.md 5.5 as it
stands does not support the screens that cite it.

## 6. Smaller open questions carried forward
- **Confidence band thresholds (0.85 / 0.60)** in tokens.css are placeholders awaiting a
  product call (tokens-preview).
- **Licensed type pair not chosen**; system font stacks stand in (tokens-preview).
- **No levels** — streaks kept (they reward rhythm), levels dropped (every level system is
  an accumulation counter, so it rewards volume — the exact thing calibrated gamification
  exists to prevent). PRODUCT.md 5.5 still says "streaks/levels."
- **Trace explorer column width** — 10 columns will not fit a laptop viewport; the screen
  currently accepts horizontal scroll rather than hiding data.
- **Skipped items never return to the same annotator** (session decision 8, home decision 6).

---

# Appendix: both BRIEF versions, verbatim

`mockups/BRIEF.md` is rewritten as a record of Phase A. Both prior versions are preserved
here in full, because each carried something the other dropped: v1 holds the tokens.css
approval, the annotator-home rejection notes, and the judge-alignment spec; v2 holds the
correct reduced scope. The rewritten BRIEF takes v2's scope and v1's memory.

## BRIEF v1 (was `mockups/BRIEF.md`)

```markdown
# Mockup Brief — Phase A (Screens as Spec)

Purpose: produce a fully reviewable set of static HTML screens that, together with `docs/PRODUCT.md`, read as a product release brief. Approval or rejection happens on these screens before any application code exists.

## Rules
- Plain HTML + CSS. No frameworks, no build tooling. Files open directly in a browser.
- Every screen imports `tokens.css` — the single, locked style guide (colors, type scale, spacing, radii, elevation). Create tokens.css FIRST and get it approved before mass-producing screens.
- Realistic fake data only (real-looking bug titles, labels, costs, names). Lorem ipsum hides UX problems.
- Each screen file gets a header comment: screen name, role that sees it, PRODUCT.md section it implements, open questions.
- Mockups are disposable. They will be screenshotted into the release brief and then rebuilt clean. Never ported.

## Screen inventory (priority order)

### P0 — The differentiator (annotator surface)
1. `annotator-session.html` — one trace at a time, plain language, agree/correct, failure note, session goal ("12 more today"). The anti-Braintrust screen; this one carries the product thesis.
2. `annotator-home.html` — streaks, personal stats, queue status. Calibrated gamification, friendly not childish.
   **DEFERRED (r1 drafted, rejected 2026-08-19).** Rebuild later, after the console
   establishes an app shell. Rejection notes:
   - No dashboard feel. Needs to read like logging into an application — persistent
     side panel and app chrome — not like a document. The "no navigation sprawl" rule
     in PRODUCT.md 5.5 applies to the *session* screen, not to this one.
   - Accuracy-section wording is wrong throughout; revisit the vocabulary before the
     layout ("check items", "matched the reviewer", the score-source framing).
   - Sequencing: this screen is lower priority than it looked; it depends on decisions
     that are not settled yet (what an annotator is shown about their own quality).

### P1 — The engineer console
3. `console-trace-explorer.html` — dense table: filters (label, confidence, judge disagreement), raw payloads on expand.
4. `console-classifier-create.html` — wizard: name, label set type, label definitions, model selection, token issuance, **annotation policy** (SME assignment, overlap rate, arbiter, honeypot rate, agreement threshold — PRODUCT.md 5.5). Must degrade cleanly to the single-SME case.
5. `console-dashboard.html` — quality over time, judge-vs-human agreement, drift indicators.
6. `console-cost-comparison.html` — frontier vs fine-tune, per-call and projected monthly dollars. The killer demo artifact.
6a. `console-eval-round.html` — **drafted ahead of the docs, 2026-08-19.** The developer's entry into the eval loop: a frozen, versioned annotation round measured with a confusion matrix, per-label TPR/TNR and κ, and the SMEs' failure notes pre-clustered as the on-ramp to axial coding. Proposes the *annotation round* object, which PRODUCT.md does not yet contain. Review the screen, then write the concept into PRODUCT.md — not the other way round.
6b. `console-judge-alignment.html` — **not yet drafted.** The second confusion matrix: judge vs human, not model vs human. The judge is the instrument that runs continuously against live traffic, so if it is uncalibrated every downstream quality number is wrong. Needs per-label TPR/TNR against a held-out human-labelled set (target ≥80% both, after Husain), agreement-over-time with drift, and TPR/TNR-based correction of the judge's estimates on unlabelled traffic — `corrected = (observed + TNR − 1) / (TPR + TNR − 1)`, the Rogan–Gladen estimator; verify against Husain's validate-evaluator before treating as spec. PRODUCT.md 5.7 currently specifies no judge-validation metric at all.

### P2 — Lifecycle moments
7. `finetune-unlock.html` — threshold progress, eligibility gate, launch-training flow.
8. `finetune-results.html` — held-out comparison, honest regressions surfaced, shadow-mode toggle, cutover.
9. `taxonomy-builder.html` — axial coding: clustered failure notes, LLM-suggested themes, human confirm/merge.
10. `alignment-session.html` — arbiter surface (PRODUCT.md 5.5, added v0.2). Disagreed items side by side with each annotator's choice and notes, arbiter resolves, and — the actual point — edits the label definitions and publishes a new version. The output is a revised rubric, not a pile of resolved items; the screen has to make that the obvious action rather than a footnote.

### P3 — Platform surfaces
11. `guest-expert-invite.html` — scoping, time-box, PII masking controls, audit notice.
12. `billing.html` — metered usage, Stripe, caps.
13. `audit-log.html` — append-only event stream with actor/timestamp/before-after.

## Approval workflow
Each screen: draft → review against PRODUCT.md section → annotate decisions/rejections inline in the HTML comment header → mark APPROVED in this file's checklist below.

- [x] tokens.css — APPROVED 2026-08-19. Direction: **Instrument** (chrome is achromatic, colour is data). Annotator/console = one palette on two axes (`data-tone`, `data-density`), with `data-surface` presets. Render check: `mockups/tokens-preview.html`.
- [ ] annotator-session
- [ ] annotator-home
- [ ] console-trace-explorer
- [ ] console-classifier-create
- [ ] console-dashboard
- [ ] console-cost-comparison
- [ ] console-eval-round
- [ ] console-judge-alignment
- [ ] finetune-unlock
- [ ] finetune-results
- [ ] taxonomy-builder
- [ ] alignment-session
- [ ] guest-expert-invite
- [ ] billing
- [ ] audit-log
```

## BRIEF v2 (was `labelloop-latest/mockups/BRIEF.md`)

```markdown
# Mockup Brief v2 — Phase A (reduced to load-bearing screens)

v1 of this brief listed 12 screens; that was platform design, not spec. Phase A now
covers ONLY the three screens the demo narrative depends on. Everything else ships as
unstyled tables when a BUILD_SPINE milestone needs it.

## Rules (unchanged)
- Plain HTML + CSS, no frameworks or build step. Every screen imports `tokens.css`.
- tokens.css is created FIRST and approved before any screen.
- Realistic fake data (real-looking inputs, labels, costs). Lorem ipsum hides UX problems.
- Header comment per file: screen name, role, PRODUCT.md section, open questions.
- Mockups are disposable spec — screenshotted into the release brief, then rebuilt clean.

## Screens
1. `annotator-session.html` (P0) — one trace at a time, plain language, agree/correct,
   failure note, session goal. The product thesis. [PRODUCT.md 5.5]
2. `console-dashboard.html` (P0) — quality by classifier version, judge-vs-human
   agreement, cost per call frontier vs fine-tune. The receipts. [PRODUCT.md 5.10]
3. `classifier-create.html` (P1) — wizard: name, labels, prompt/context, model →
   version 1 + API key reveal (shown once). The interviewer's entry point. [5.2, 5.1]

## Deferred (unstyled until a milestone demands better)
trace explorer, taxonomy builder, fine-tune screens, guest-expert invite, billing
(Stripe-hosted where possible), audit log viewer, annotator home/gamification.

## Approval checklist
- [ ] tokens.css
- [ ] annotator-session
- [ ] console-dashboard
- [ ] classifier-create
```

