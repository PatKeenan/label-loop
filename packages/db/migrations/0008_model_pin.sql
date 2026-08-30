-- ADR-0022 / ADR-0025: a frozen judge version pins a CAPABILITY CONTRACT, not a model name.
--
-- **Order is the whole point of hand-writing this.** Drizzle generates the two ADD COLUMNs
-- followed immediately by the CHECK, which would abort on any database holding `llm` rows —
-- every one of them has a NULL pin the instant the column appears. So the backfill goes
-- between them, and the constraint is added only once the rows can satisfy it.
--
-- Forward-only, no down migration (ADR-0006).

ALTER TABLE "judge_versions" ADD COLUMN "model_pin" jsonb;--> statement-breakpoint
ALTER TABLE "judge_versions" ADD COLUMN "model_pin_validation" jsonb;--> statement-breakpoint

-- Every `llm` judge that exists today is one of the four M0-seeded `fake:deterministic`
-- ones, and they get the default fake pin (`DEFAULT_FAKE_PIN` in `@labelloop/contracts`).
-- It constrains nothing — a `fake:` route has no endpoints to route among — and it is
-- written anyway so the CHECK below can be ADR-0022's clean mirror of the model/type rule
-- rather than a route-conditional special case.
--
-- Scoped to `fake:%` DELIBERATELY, rather than to every un-pinned `llm` row. The two are
-- identical against today's data, and they differ in how they fail: if a row naming a real
-- model somehow existed, the broad version would silently hand it `effort: none` — which is
-- a hard 400 on any model whose reasoning is mandatory, i.e. a permanently broken judge.
-- This version lets the CHECK below reject it instead, in a transaction that rolls back and
-- names the constraint. A migration that guesses is worse than one that stops.
UPDATE "judge_versions"
SET "model_pin" = '{"capabilities":["structured_outputs"],"data_collection":"deny","reasoning":{"effort":"none"}}'::jsonb
WHERE "type" = 'llm' AND "model_pin" IS NULL AND "model" LIKE 'fake:%';--> statement-breakpoint

ALTER TABLE "judge_versions" ADD CONSTRAINT "judge_versions_pin_matches_type" CHECK (("judge_versions"."type" = 'code' AND "judge_versions"."model_pin" IS NULL)
          OR ("judge_versions"."type" = 'llm' AND "judge_versions"."model_pin" IS NOT NULL));
