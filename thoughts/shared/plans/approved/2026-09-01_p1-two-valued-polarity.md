---
date: 2026-09-01T00:00:00Z
author: claude-code
status: approved
approved_at: 2026-09-01T00:00:00Z
approved_by: pat
milestone: M5
topic: p1-two-valued-polarity
related_adrs: [0034, 0019, 0003, 0006, 0022, 0025, 0026]
research: thoughts/shared/research/2026-08-31_adr-0034-two-valued-polarity.md
---

# P1 — Two-valued polarity: the mechanical narrowing

## Goal

Implement ADR-0034's schema and code change: delete `does_not_score` from `judge_polarity`,
make `judge_versions.weight` unconditionally NOT NULL and positive, and collapse the branches
in `evaluate.ts` and the published contract that existed to describe a judge which scored
nothing. After this, `passed` is null for exactly one reason — the judge did not run — and
every judge in a panel carries a weight, contributes to the score, and can fail the panel.

**Milestone: M5.** BUILD_SPINE names this explicitly as M5's prerequisite
(`docs/BUILD_SPINE.md:110-117`) and requires it to land *before any annotation row does*,
because ADR-0003 freezes judge versions and M5's annotations FK to them. It is implemented
now, ahead of M2, precisely because every database is still disposable.

**Out of scope by design:** the replacement seeded panel (P2) and the documentation sweep
(P3). See research D9 for why the phases are separate.

## Why this is ONE phase and one PR

The change is atomic at the type level, not merely convenient to batch. Narrowing the pgEnum
narrows Drizzle's inferred union, which makes `polarity === 'does_not_score'` in
`evaluate.ts` a comparison against a non-overlapping literal — a typecheck error. There is no
ordering of these edits that leaves the tree green in between, so splitting the work would
ship a knowingly broken commit. One branch, one PR: `feat/m5-p1-polarity`.

## Phase 1 — the narrowing (the only phase)

### Schema

- [x] `packages/db/src/schema/columns.ts:83-94` — `judgePolarity` becomes
      `pgEnum('judge_polarity', ['passes', 'fails'])`. Rewrite the doc comment: it currently
      argues *for* three values using `is-bug` as its example, so it is not an edit but a
      replacement. State what polarity is (whether answering `true` is good news or bad news
      for what the judge examines) and cite ADR-0034 for why there is no third value.
- [x] `packages/db/src/schema/judge-versions.ts` — `weight: real('weight').notNull()`.
- [x] Same file — replace the `polarity` doc comment (the "THE column this table exists to
      get right" block), which is written entirely around the three-valued case.
- [x] Same file — drop `judge_versions_weight_matches_polarity` and add
      `judge_versions_weight_positive`: `check('judge_versions_weight_positive', sql\`${table.weight} > 0\`)`.
      The old comment's argument about `NULL > 0` evaluating to NULL stops being
      load-bearing once the column is NOT NULL; keep the positivity check and rewrite the
      comment to say why a zero-weight judge is still meaningless.

### Migration

- [x] `bun run db:generate` — for `meta/0009_snapshot.json` and the `_journal.json` entry
      only. Never hand-write those (`migrations.test.ts` asserts file/journal agreement,
      contiguous indexes and monotonic timestamps).
- [x] Hand-write `packages/db/migrations/0009_two_valued_polarity.sql`, replacing whatever
      drizzle-kit emitted, in the ordered form below. Header comment in the style of
      `0008_model_pin.sql`: state that ordering is the reason it is hand-written.
- [x] The guard runs first and **refuses rather than converts**:

      ```sql
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM judge_versions WHERE polarity = 'does_not_score') THEN
          RAISE EXCEPTION 'judge_versions holds does_not_score rows, removed by ADR-0034. '
            'Every database is disposable at this point: run '
            '`docker compose -f infra/docker-compose.yml down -v` and boot again.';
        END IF;
      END $$;
      ```

- [x] Then, in this order, each separated by `--> statement-breakpoint`:
      1. `ALTER TABLE judge_versions DROP CONSTRAINT judge_versions_weight_matches_polarity;`
         — **first**, because it names the literal `'does_not_score'` and is therefore a
         dependency on the type being replaced.
      2. `ALTER TABLE judge_versions ALTER COLUMN polarity SET DATA TYPE text;`
      3. `DROP TYPE public.judge_polarity;`
      4. `CREATE TYPE public.judge_polarity AS ENUM('passes', 'fails');`
      5. `ALTER TABLE judge_versions ALTER COLUMN polarity SET DATA TYPE public.judge_polarity USING polarity::public.judge_polarity;`
      6. `ALTER TABLE judge_versions ALTER COLUMN weight SET NOT NULL;`
      7. `ALTER TABLE judge_versions ADD CONSTRAINT judge_versions_weight_positive CHECK (weight > 0);`
- [x] Comment step 6 with why the guard is sufficient for it: the *old* CHECK guaranteed
      `weight IS NULL` exactly when `polarity = 'does_not_score'`, so a database with no
      such rows has no null weights. That inference is the only thing standing between this
      statement and a failed migration, and it is worth writing down.
- [x] No re-grant is needed. `0000_privileges.sql` grants on TABLES via
      `ALTER DEFAULT PRIVILEGES`; recreating a type does not touch table privileges, and
      `0005_immutable_versions.sql`'s REVOKE on `judge_versions` is unaffected by DDL run as
      the migrator.

### API

- [x] `apps/api/src/repositories/panels.ts:24-26` — `polarity: 'passes' | 'fails'`, and
      `weight: number` with its "Null exactly when the judge does not score" comment replaced.
- [x] `apps/api/src/services/evaluate.ts:53-65` — `passedUnderPolarity` returns `boolean`,
      not `boolean | null`: `polarity === 'passes' ? verdict : !verdict`. Rewrite the block
      comment above it, which uses `is-bug` as its third example.
- [x] Same file, `aggregate` — delete `scoringConfigured`; `contributing` filters `results`
      directly on `outcome.status === 'evaluated'`.
- [x] Same file — `totalWeight` and `share` lose their `?? 0` and their `scoring` term;
      `share` is non-null whenever the judge evaluated and `totalWeight > 0`.
- [x] Same file — `complete` becomes `results.length === contributing.length`.
- [x] Same file — `passed` loses the `scoringConfigured.length === 0 ||` disjunct and its
      comment about a panel with no scoring judges, which is now unreachable.
- [x] Same file, `evaluate` — delete the `scoringConfigured` and `scored` locals;
      `nothingUsable` collapses to `evaluated.length === 0`. Rewrite the block comment,
      which explains a case that no longer exists.

### Contracts

- [x] `packages/contracts/src/evaluate.ts:17-19` — the header paragraph asserting three
      polarities.
- [x] Same file, `verdictSchema.passed` description — "Null in two distinct cases, which
      `status` disambiguates" becomes one case: the judge never answered. Keep the
      `verdict` vs `passed` distinction, drop the `is-bug` example.
- [x] Same file, `verdictSchema.weight` description — "null when it did not contribute —
      informational, skipped, failed or errored" loses `informational`.
- [x] Same file, `evaluationSchema.score` description — drop "Informational judges are
      absent from both the numerator and the denominator — a label is not a grade".
- [x] Same file, `evaluationSchema.complete` description — "every scoring judge" becomes
      "every judge", since the two sets are now identical.

### Seed

The three `does_not_score` judges are **deleted**, not rewritten. `needs-human` is kept as
the panel's sole judge until P2 — and kept knowingly as a placeholder, because it is invalid
under ADR-0034's product test even though it is legal under the new enum (research D12).

- [x] `scripts/seed-judges.ts` — `JudgePolarity` becomes `'passes' | 'fails'`.
- [x] Same file — delete `is-bug`, `is-feature` and `is-question` from `JUDGES`. No
      replacements are authored. P1 changes the enum; it does not design a panel.
- [x] Same file — `needs-human` is unchanged (`fails`, weight 1, required, `SEED_MODEL_A`).
- [x] Same file — rewrite the `JUDGES` doc comment, which names exercising all three
      polarities as the panel's reason for existing. Replace it with a short, honest note:
      this is a one-judge placeholder panel; `needs-human` asks a question that produces a
      fact the caller's system needs rather than gating something their agent produced, so
      it is **work, not evaluation** (ADR-0034), and P2 replaces it along with everything
      else. Written so nobody reads the row as a product capability the way the M0 four were.
- [x] Same file — `MODEL_VARS` and `PINNED_EFFORTS` stay exactly as they are. Only
      `SEED_MODEL_A` is read while one judge exists; B and C go unused for one PR and are
      used again at P2. Deleting them would be churn in both directions.
- [x] `scripts/seed.ts` — no change. Panel slug, ids, key and console output all still hold.

### Tests

- [x] `packages/db/src/schema/constraints.test.ts:140-205` — rewrite the describe block.
      "An informational judge with no weight is accepted" and "an informational judge WITH a
      weight is rejected" go; "a scoring judge WITHOUT a weight is rejected" stays and now
      asserts a NOT-NULL violation (`23502`) rather than a check violation.
- [x] Same file — retarget "polarity outside the three values is not even representable" at
      `does_not_score` itself, still expecting `22P02`. This is the permanent guard that the
      value never comes back, and it is the single most valuable test in this change.
- [x] Same file — the `insertJudgeVersion` helper's `polarity` parameter type and any
      `weight: null` default.
- [x] `packages/db/src/schema/relations.test.ts:36-39, 55-64` — the seeded panel now pins
      ONE judge. `toHaveLength(4)` becomes 1, the slug list collapses to `needs-human`, and
      the scoring filter (which was the point of the test) is replaced by an assertion that
      every pinned judge has a non-null weight and a polarity in the two-valued set.
- [x] `apps/api/src/services/evaluate.test.ts` — delete "an informational judge failing does
      not make the panel incomplete" and "a panel of nothing but labels makes no claim to
      fail". Both test behaviour ADR-0034 removes; neither should be bent into something
      else. Update the four `does_not_score` fixture sites.
- [x] `apps/api/src/routes/public/v1/evaluate.test.ts:85-110, 290-310` — the two-judge
      fixture becomes two scoring judges of opposing polarity, and the assertions that read
      `passed: null` off the label become assertions that both judges score.
- [x] `packages/contracts/src/evaluate.test.ts:145-165` — delete the informational-versus-
      skipped disambiguation test. It exists *only* to prove the ambiguity ADR-0034 removes,
      so keeping it in any form would be asserting the opposite of the decision.
- [x] Same file:120-126, 300-320 — the "a label is not a grade" test and the four-judge
      example fixture, which currently has three judges at `passed: null, weight: null`.
- [x] `scripts/seed-judges.test.ts` — four sites, and one of them is a real coverage loss:
      - `:54-66` "the three variables pin four judges across three labs" **loses its
        subject**. `resolveSeededJudges` takes only `env` and reads the module-level
        `JUDGES`, so there is no seam to inject a multi-judge fixture without changing its
        signature — which is out of scope here. Delete it, with a comment naming P2 as where
        it returns. See the cost recorded below.
      - `:160-161` `validations.size` becomes 1 and the `is-bug` lookups become `needs-human`.
      - `:191` "a pin that cannot route fails the whole seed, naming the judge" drives the
        failure through `SEED_MODEL_C` and expects the message to name `is-question`. Switch
        it to `SEED_MODEL_A` and `needs-human`; the test's point — the seed refuses and names
        the judge — is unaffected.
      - The variable-resolution tests that do NOT depend on judge count (empty string treated
        as unset, non-route-qualified value naming the VARIABLE, missing key) all stay.
- [x] **No change** to `apps/api/src/llm/spans.test.ts`, which uses `'is-bug'` as a
      free-standing fixture string unrelated to the seed. Named here so it is not churned.

### Automated verification

- [x] `bun run typecheck`
- [x] `bun run lint`
- [x] `bun test` — the whole workspace, against a real Postgres
- [x] `docker compose -f infra/docker-compose.yml down -v && docker compose -f infra/docker-compose.yml up -d --wait --build` — a fresh database migrates through 0009 and seeds clean

### Manual verification

- [x] **The guard fires.** On a database seeded *before* this change (check out `main`, run
      `bun run db:setup`, return to the branch, run `bun run db:migrate`), migration 0009
      refuses with the named message rather than a raw enum cast error. This is the one step
      that proves the decision not to convert, and it cannot be asserted in a test that runs
      against a fresh database.
- [x] The README's walkthrough curl against `pnl_000000000000000000SEEDPANE` returns a
      verdict for every judge with a **non-null `passed` and a non-null `weight`**, and
      `score` is computed over four judges rather than one.
- [x] `bun run db:seed` twice: the second run is silent, makes no network call, and prints
      the same single judge.
- [ ] With `SEED_MODEL_A` pointed at a real model and a key exported, the seed still
      validates its one pin and prints an endpoint count. The three-lab demo is dark for
      this PR and returns at P2 — confirm the machinery still works with one judge.

## Deviations

Recorded during implementation on 2026-09-01. None changes the decision; all four are the
plan's inventory of edit sites being slightly short of what the tree actually held.

- **`scripts/seed-judges.test.ts` needed six sites, not four**, and two of them are ones the
  plan explicitly said would stay. The plan's rule — "the variable-resolution tests that do
  NOT depend on judge count all stay" — turns out not to separate them: those tests do not
  depend on the judge COUNT, they depend on which VARIABLE is read, and with `SEED_MODEL_B`
  and `SEED_MODEL_C` now naming no judge, a bad value set on either is never resolved and
  nothing throws. Both were re-pointed at `SEED_MODEL_A` with a comment saying why and that
  P2 widens them again; each test keeps its exact subject (the message names the variable,
  the message names the key). The two further sites the plan did not enumerate:
  `:37-44`, whose `toHaveLength(4)` and four literal models became `JUDGES.length`, and
  `:90-94` "no fourth knob crept in", which asserted set EQUALITY against all three
  variables and is now a subset assertion — the invariant worth keeping is that no judge
  reaches for a knob outside `MODEL_VARS`, and equality cannot hold until P2.
- **`constraints.test.ts` gained a test rather than only losing two.** The plan retargets
  the representability test at `does_not_score`; it is now two tests, one for
  `does_not_score` (the ADR-0034 regression guard, commented as such) and one for an
  arbitrary value, because they guard different things and collapsing them would let the
  guard be deleted as a duplicate later. A zero-weight rejection test was also added: the
  old CHECK's positivity half was only ever exercised incidentally through the null case,
  and with presence moved to the column it would otherwise have no test at all.
- **drizzle-kit emitted the plan's ordering unmodified.** `bun run db:generate` produced the
  seven statements in exactly the order the plan specifies, including dropping the old CHECK
  first. The migration was still hand-finished — renamed from `0009_wild_dakota_north` in
  both the file and `_journal.json`, guard prepended, comments added — but nothing generated
  had to be reordered.
- **`infra/k6/smoke.js` hardcodes the seeded panel's four judge slugs**, and the plan's
  edit inventory did not reach outside `apps/`, `packages/` and `scripts/`. Its
  `evaluate ran every seeded judge` and `every judge reasoned before it answered` checks
  both failed on CI's first run of PR #35 while every other job passed — the one gate that
  exercises the actual seeded panel end to end, and so the one that noticed. Narrowed to
  `['needs-human']` with a comment naming P2 as where it grows back. Worth noting for P2:
  this file is a THIRD place the seeded judge set is written down, after `seed-judges.ts`
  and `relations.test.ts`, and none of the three references the others.
- **One source file the plan did not enumerate: `packages/db/src/schema/trace-verdicts.ts`.**
  Both its `status` and `passed` doc comments assert the two-reasons-for-null semantics
  ADR-0034 removes. The COLUMN is untouched and stays nullable, correctly — a judge that
  never ran has no `passed` — so this is comment-only, but it is source rather than prose
  and so is not P3's sweep to make. Rewritten here with the rest of them.
- **The plan's own manual-verification line is wrong about the judge count.** It asks that
  the README curl show "`score` computed over four judges rather than one"; P1 deliberately
  leaves ONE judge, and P2 authors the replacements. The substantive half of that check —
  every judge returns a non-null `passed` and a non-null `weight` — was verified and holds.

## Decisions made

- **The migration refuses a pre-existing `does_not_score` row rather than deleting or
  converting it.** Converting means guessing a polarity and a weight for a row whose whole
  property was having neither; `0008_model_pin.sql` already argues the general case — *a
  migration that guesses is worse than one that stops*. Every database is disposable today
  and stops being so at M5.
- **`weight` becomes a column-level NOT NULL, not a CHECK.** It flows into Drizzle's inferred
  types, which removes the null from `PanelJudge['weight']` for free and turns "the score is
  uncomputable" into a compile error rather than a runtime one.
- **The CHECK is renamed `judge_versions_weight_positive`.** `weight_matches_polarity` names
  a relationship that no longer exists, and a constraint whose name lies is worse than one
  that is verbose.
- **The enum values stay `passes` and `fails`** (research D10). A rename to
  `true_is_pass`/`true_is_fail` was raised — the names have been misread twice — and declined
  by the stakeholder. Recorded so it is not re-opened during implementation.
- **`Verdict.weight` stays nullable while `judge_versions.weight` becomes NOT NULL.** They
  are different fields sharing a name: one is configuration, the other is the normalised
  share actually applied, which is genuinely absent for a judge that never ran.
- **The three label judges are deleted and nothing is authored to replace them.** Assigning
  them arbitrary polarities would ship rows that mean nothing in order to satisfy a
  constraint; authoring four new judges would invent hand-written fixtures with no error
  analysis behind them, which is the exact mistake ADR-0034 diagnosed in the M0 four. The
  seed's remaining jobs — the multi-judge fan-out demo and the three-lab pin validation —
  are README and demo surface, and the README is stale until P3 regardless.
- **One test's coverage is deliberately dropped for one PR.** "The three variables pin four
  judges across three labs" cannot be kept with a one-judge panel, and `resolveSeededJudges`
  offers no seam to inject judges. What is lost is narrow — that several judges resolve to
  several different models — and what remains covers the fallback, the empty-string case, the
  unqualified-value message and the missing-key refusal. It returns at P2. Recorded because a
  silently deleted test is how coverage erodes.
- **`needs-human` is kept as a knowingly invalid placeholder** (research D12). It is legal
  under the new enum and wrong under ADR-0034's work-versus-evaluation test, and the seed
  says so in a comment. The alternative is converting it to its evaluation form
  (`context` carries the agent's routing decision, the judge asks whether that misjudges the
  issue), which requires `context` on the seeded call — D4, and P2's work.
- **One phase, one PR**, because narrowing the enum makes `evaluate.ts` a typecheck failure
  until it is edited — there is no green intermediate state.
- **`constraints.test.ts`'s representability test is retargeted at `does_not_score`** as a
  permanent regression guard, rather than deleted along with the block it lives in.

## Explicitly NOT doing

- **The replacement seeded panel** — the voice-alignment panel is P2 and waits on the
  open-coding pass (research D3, D7, D11).
- **`context` on the seeded evaluation** — required by the voice panel (D4), not by this.
- **The prose sweep.** CLAUDE.md, CONVENTIONS, PRODUCT and README continue to describe
  three-valued polarity after this PR lands. That is deliberate and P3 fixes it; the
  alternative is a single enormous PR whose review is impossible.
- **Renaming the enum values** (D10).
- **Wiping the migration stream** — considered and rejected in ADR-0034.
- **M5's dogfooding artifact** (D2) — reopened, deferred to M5.
- **Any new dependency or tool.** Nothing here touches `docs/STACK_DECISIONS.md`.

## Open questions

1. **How far out is P2?** Settled in favour of deleting the three judges partly on the
   assumption that the open-coding pass happens soon. If it slips by more than a few weeks,
   the seed is a one-judge panel for that whole time and the three-lab demo stays dark —
   recoverable by authoring judges then, but worth knowing rather than discovering.
2. **Confirm "every database is disposable" still holds** for anyone else who has cloned
   this repo. It does for the local development story; the guard makes the failure loud
   either way.
3. **PR title.** Proposed: `feat(db)!: every judge scores, and polarity becomes two-valued`.
   The `!` is arguable — no response *shape* changes, only the semantics of `passed` narrow
   and `judge_versions.polarity` accepts fewer values. Nothing is deployed and nothing
   external writes those rows, so it could equally ship without the bang.
