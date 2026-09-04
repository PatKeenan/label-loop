---
date: 2026-09-04T00:00:00Z
author: claude-code
status: approved
approved_at: 2026-09-04T00:00:00Z
approved_by: pat
milestone: M5
topic: p3-polarity-prose
related_adrs: [0034, 0035, 0036, 0037, 0019]
research: thoughts/shared/research/2026-09-04_p2-voice-panel-seed.md
predecessor: thoughts/shared/plans/complete/2026-09-01_p1-two-valued-polarity.md
---

# P3 — the prose: two-valued polarity, and classification out of the product

## Goal

P1 shipped the schema and the code; it deliberately left every prose document describing
the retired model, on the grounds that one enormous PR would be unreviewable. This closes
that gap. After it, no living document claims polarity is three-valued, claims a label set
can be expressed as N judges, or describes a seeded panel of four judges that no longer
exists. It is prose only — no code, no schema, no test behaviour, no new dependency.

**Milestone: M5.** Same milestone as P1 and P2 (`docs/BUILD_SPINE.md:104-117`, which names
the polarity change as M5's prerequisite). This is P1's third phase, deferred by design.

**Scope boundary, and it is the reason this plan is small.** Three ADRs settle everything
here: ADR-0034 (every judge scores; classification leaves V1), ADR-0035 (`weight` is two
fields), ADR-0036 (a judge must gate, not inform). Anything *not* settled by them — what
the seeded panel becomes, what the dogfooding tenant judges, the 500-trace metric — is
parked, not guessed. See "Explicitly NOT doing".

## Why one phase and one PR

The same sentence is restated in eight places across five documents. Correcting them in
separate PRs is precisely how the product ends up saying two things again — which is the
condition this plan exists to end, not to prolong. There is no build to break and no
intermediate state to keep green, so the argument that split P1 from P2 does not apply.

Branch: `docs/m5-p3-polarity-prose`. PR title:
`docs: polarity is two-valued, and classification leaves the product`.

## Phase 1 — the sweep (the only phase)

### The doctrine: three-valued polarity

Every site states the same retired rule with the same `is-bug` example. Each becomes: a
judge declares whether answering `true` **passes or fails**, two-valued, because every judge
scores, participates in the score, and can fail the panel (ADR-0034). Keep the reason
polarity exists at all — summing raw booleans across judges pointing in opposite directions
is meaningless — and keep the `verdict` vs `passed` distinction, since both survive. Drop
`is-bug` as the third example everywhere; `is-missing-repro` and `on-brand` still work.

- [ ] `CLAUDE.md:6` — the domain paragraph, second sentence. This one is load-bearing beyond
      documentation: it is injected into every session as project instructions, so a stale
      sentence here is a stale sentence in every future context window.
- [ ] `docs/CONVENTIONS.md:61-69` — the polarity bullet, including the trailing clause about
      `null` for informational judges. `null` now has exactly one meaning: the judge never
      answered. Cite ADR-0034 in the bullet, as neighbouring bullets cite their ADRs.
- [ ] `docs/PRODUCT.md:58` (§5.2) — the polarity bullet. Its last sentence ("A triage panel
      is mostly informational judges plus a gate or two; a taste panel is mostly scoring
      ones") is not an edit but a deletion: the contrast it draws no longer exists, since
      there is only one kind of judge.
- [ ] `README.md:519-523` — see "the seeded panel" below; the polarity rationale there is
      entangled with the judge list and is rewritten as one block.

### The doctrine: classification as a separate capability

ADR-0034 removes the ability to express a valence-free label at all, so "a label set becomes
N judges" is now false rather than merely awkward. **The anti-multi-class rule it sits next
to survives untouched** — a judge is one binary question, never a bundled multi-criteria
call (`docs/CONVENTIONS.md:53-57`, ADR-0019) — so each of these keeps the rule and loses
the label-set claim. Getting this split wrong in either direction is the main risk in the
phase.

- [ ] `CLAUDE.md:6` — "Classification is not a separate mode: a label set is N binary
      judges." Deleted. The adjacent `cls_`/`clv_` retirement note stays true and stays.
- [ ] `docs/PRODUCT.md:13` — the positioning block's last sentence. Its conclusion ("bug
      triage and taste validation are the same operation performed on artifacts from
      different sources") is the part ADR-0034 narrowed, and it is the sentence the
      triage persona below rests on.
- [ ] `docs/PRODUCT.md:34` (core loop step 1) — "A label set becomes N judges, not one
      multi-class call" becomes the binary-question rule alone.
- [ ] `docs/PRODUCT.md:56` (§5.1) — same, in the CRUD bullet.
- [ ] `README.md:89-90` (core loop step 1) — same. Keep "a verdict you can measure is worth
      more than a verdict you can only read", which is the good half of the sentence.

### The triage persona

`is-bug`, `is-feature` and `is-question` are unexpressible (ADR-0034) and `needs-human`
fails the gate-not-work bar (ADR-0036). The persona is rewritten into its evaluation form
rather than deleted — **settled by the stakeholder on 2026-09-04**, over deleting it and
shipping one persona.

The shape is ADR-0036's own worked example, and the plan states it rather than leaving it
to be re-derived: **the panel gates the triage bot's own routing decision**. The inbound
issue is the artifact, the route the bot chose goes in `context`, and the judge asks whether
that decision misjudges the issue — `mis-routed`, `polarity: fails`, so `true` means their
agent got it wrong. That gates rather than informs, it is alignable against an expert, and
it is what error analysis over their traffic would actually surface.

Two constraints on the rewrite:

- **Every judge named in the bullet clears both bars** (ADR-0034 and ADR-0036), and each is
  checked individually — a failure mode of a triage bot can still be a fact we are being
  asked to manufacture. The old bullet named four judges and the taste bullet names three,
  so there is a pull toward padding to match. **Naming one judge is the correct answer if
  one is what clears the bars**; the parallel structure is not worth a judge that does not.
- **The artifact is still the inbound issue**, which the caller did not produce. What moves
  it across the line is `context` carrying the caller's own determination, so a rewrite that
  drops `context` from the description has silently restored the classification shape.

The **taste** persona is untouched in both files (D3).

- [ ] `docs/PRODUCT.md:27` — the Triage bullet.
- [ ] `README.md:63-64` — the same persona, in "Who it is for".
- [ ] Both keep the closing line that follows them — *"the only difference is where the
      artifact came from"* — but it now needs a caveat rather than a deletion: under
      ADR-0034 the artifact must be something the caller's system produced or decided, which
      is a property of our system. Rewrite the line rather than leaving it to contradict the
      ADR two paragraphs later.

### The dogfooding commitment, marked reopened

**Settled by the stakeholder on 2026-09-04**, over leaving it standing and wrong. One
appended sentence per site — the commitment itself is not rewritten, because what this repo
dogfoods is a product decision reopened against M5 (D2) and not one a prose PR makes.

The appended sentence has to carry **both** halves of the reopening, or it marks the safer
half and leaves the other advertised:

- **The artifact.** D2: this repo has produced roughly 34 PRs against an effectively empty
  issue tracker, an order of magnitude short of 500 annotated traces.
- **The panel.** All four named judges are retired — three unexpressible under ADR-0034,
  `needs-human` failing ADR-0036's gate-not-work bar. An append that mentions only the
  trace count leaves §8 still advertising a live panel of four judges that cannot exist.

Both sentences point at `docs/BUILD_SPINE.md` M5, which is where the reopening is tracked.

- [ ] `docs/PRODUCT.md:171` (§8) — append the sentence. The commitment's prose is otherwise
      untouched, including the four judge slugs: they are what the appended sentence is
      about, so removing them would leave the correction referring to nothing.
- [ ] `docs/PRODUCT.md:165` (§7, ≥ 500 annotated traces) — the same commitment stated a
      second time, including the same *"this project's own GitHub issues"* claim. Extended
      to §7 as a judgement call rather than on instruction: marking §8 reopened while §7
      restates it unqualified reproduces the exact two-documents-disagreeing failure this
      plan exists to end. Flagged here so it can be pulled back out if that reads as scope.

### The seeded panel, as it actually is

Not stale doctrine — **factually wrong output**. P1 left one judge; these three sites
describe four. A reader following the walkthrough today sees a mismatch on the first curl.

- [ ] `README.md:513-523` — the seeded-panel section. It becomes: one placeholder judge,
      named as scaffolding rather than as a capability (D5), with a forward pointer to the
      replacement panel. Say plainly that it is a placeholder and why the previous four were
      removed — the honest version is more interesting than the panel was.
- [ ] `README.md:635-638` — the pinned-endpoint table printed by the migrate one-shot. Four
      rows become one, and the surrounding claim that the walkthrough "returns three labs'
      verdicts on one request" is false while only `SEED_MODEL_A` is read. State that the
      three-lab demo is dark until the panel is re-authored rather than quietly printing one
      row under unchanged prose.
- [ ] `README.md:684-688` — the span tree. "Nine spans" becomes three, and the four `judge`
      children become one. The paragraph after it about nesting, backoff events and
      `circuit_open` is unaffected and stays.
- [ ] Re-run the walkthrough and paste real output rather than editing the old block by
      hand. Both blocks are transcripts; hand-editing a transcript is how they drifted.

### BUILD_SPINE

- [ ] `docs/BUILD_SPINE.md:108-117` — the M5 prerequisite paragraph is written in the future
      tense about work that has now shipped ("**Prerequisite, and it lands before any
      annotation row does**"). It becomes a record: what landed, in which PR, and that the
      seeded panel is a one-judge placeholder until it is re-authored. The paragraph above
      it (lines 104-107, the reopened dogfooding tenant) is still true and stays.

### Automated verification

- [ ] `bun run lint` and `bun run typecheck` — nothing should change, and that is the point:
      a prose PR that moves either is a prose PR that touched code.
- [ ] `bun test` — same reasoning.
- [ ] The vocabulary is gone from living documents. This is the check that actually tests
      the phase, and it should be run and pasted into the PR:

      ```bash
      grep -rniE 'three-valued|does_not_score|does not score|no valence|informational judge|label set' \
        --include='*.md' . | grep -vE 'node_modules|^\./thoughts/|^\./docs/adr/|CHANGELOG'
      ```

      Expected: no hits. `docs/adr/` and `thoughts/` are historical records and are excluded
      deliberately — ADR-0019 carries its own superseded note (`:70`) and must keep saying
      what it originally said. `CHANGELOG.md` is generated by release-please.

### Manual verification

- [ ] Read the five doctrine sentences (`CLAUDE.md`, CONVENTIONS, PRODUCT §5.2, PRODUCT
      positioning, README core loop) one after another in a single sitting. They should say
      the same thing in different registers; if any two could be read as disagreeing, the
      phase has not done its job.
- [ ] `docker compose -f infra/docker-compose.yml down -v && … up -d --wait --build`, then
      follow the README walkthrough top to bottom. Every judge list, table and span count it
      prints matches what the README says it prints.
- [ ] `docs/PRODUCT.md` §7 and §8 both name the reopening and both point at BUILD_SPINE M5.
      Read §8 as a newcomer would: it should be impossible to finish the paragraph still
      believing that panel of four judges is live.
- [ ] The `docs/adr/` directory is untouched by the diff.

## Decisions made

- **One PR, not three.** The failure this plan corrects is documents disagreeing with each
  other; correcting them separately reproduces it. There is no green-tree argument for
  splitting, because no code changes.
- **The anti-multi-class rule survives while the label-set claim dies.** They are one
  sentence in five places and only half of it is retired: a judge is still one binary
  question (ADR-0019, CONVENTIONS), but a valence-free label set can no longer be expressed
  at all (ADR-0034). Recorded because merging the two is the likeliest way to get this wrong.
- **The triage persona is rewritten into its evaluation form, not deleted** — the
  stakeholder's call, 2026-09-04. ADR-0036 supplies the worked example, and it is a better
  demonstration than a persona quietly disappearing: the customer need survives, expressed
  as a gate on the caller's own determination, which is the design move that ADR recommends
  trying before rejecting a use case. Deleting it would also leave one persona, which reads
  as the product narrowing further than it did. **The cost accepted with it:** a product
  decision ships inside a prose PR, so the PR description has to name it rather than letting
  it arrive as a documentation edit.
- **§8 and §7 are marked reopened rather than left standing or rewritten** — the
  stakeholder's call, 2026-09-04. Appending is a documentation act and stays inside a prose
  PR's remit; rewriting the commitment would be deciding what this repo dogfoods, which is
  M5's question. The append names the retired panel as well as the trace count, because
  marking only the count leaves four unexpressible judges advertised as a live commitment.
- **The README's seeded-panel sections are in scope even though they describe the panel P2
  replaces.** They are not stale doctrine — they are wrong about output a reader sees on the
  first curl. A README that describes four judges when one prints is worse than one that
  admits to a placeholder.
- **Transcripts are re-run, not hand-edited.** The pinned-endpoint table and the span tree
  drifted because they were maintained by hand; the fix should not be applied by hand.
- **`docs/adr/` and `thoughts/` are excluded.** ADRs are dated decisions and thoughts are
  provenance for the public writeup; editing either to match today's product destroys the
  record that the decision was made at all. ADR-0019 already carries its superseded note.
- **`CLAUDE.md` is treated as the highest-value site, not just another file.** It is
  injected as project instructions every session, so it is the one stale sentence that
  actively propagates.

## Explicitly NOT doing

- **The replacement seeded panel (P2)** and the open-coding pass behind it. Deferred by the
  stakeholder on 2026-09-04: nothing forces it, since ADR-0003's clock applies to P1's
  migration and not to a panel no annotation will ever reference. The prose here describes
  the placeholder honestly instead of describing a panel that does not exist yet.
- **Inventing what replaces the dogfooding commitment.** §8 and §7 are *marked* reopened
  above, which is a documentation act. Deciding what this repo actually dogfoods is a
  product decision, it is reopened against M5 by D2, and a prose PR is not where it happens.
  The appended sentence is the whole of the change; if implementation finds itself drafting
  a replacement tenant, it has left the plan.
- **PRODUCT §5.7's missing judge-validation metric and the consensus-free scoring
  contradiction** — from the Phase A design harvest, unrelated to ADR-0034, still awaiting
  human calls (`mockups/BRIEF.md`).
- **Any code, schema, test, fixture or seed change.** If the diff touches anything outside
  `*.md`, the phase has exceeded its scope.
- **Any new dependency or tool.** Nothing here touches `docs/STACK_DECISIONS.md`.

## Open questions

1. **Does this PR record itself?** P1 got an entry in `thoughts/shared/progress/decisions-log.md`
   via `/log_decision`. The P2 deferral is a real sequencing decision made in conversation
   on 2026-09-04 and is currently recorded nowhere but this plan's "Explicitly NOT doing".
