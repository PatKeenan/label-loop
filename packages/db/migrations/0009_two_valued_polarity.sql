-- ADR-0034 / ADR-0035: every judge scores. `does_not_score` leaves `judge_polarity`, and
-- `weight` becomes unconditionally NOT NULL and positive.
--
-- **Order is the whole point of hand-writing this**, and so is the guard on top. Postgres
-- adds enum values easily and does not remove them, so the type is recreated and the column
-- swapped through `text` — and the old CHECK has to be dropped FIRST, because it names the
-- literal `'does_not_score'` and is therefore a dependency on the type being replaced.
--
-- Forward-only, no down migration (ADR-0006).

-- The guard REFUSES rather than converts. Converting means guessing a polarity and a weight
-- for a row whose whole property was having neither, and `0008_model_pin.sql` already argues
-- the general case: a migration that guesses is worse than one that stops. Every database is
-- disposable today and stops being so at M5, when annotations FK to frozen judge versions.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM judge_versions WHERE polarity = 'does_not_score') THEN
    RAISE EXCEPTION 'judge_versions holds does_not_score rows, removed by ADR-0034. '
      'Every database is disposable at this point: run '
      '`docker compose -f infra/docker-compose.yml down -v` and boot again.';
  END IF;
END $$;--> statement-breakpoint

ALTER TABLE "judge_versions" DROP CONSTRAINT "judge_versions_weight_matches_polarity";--> statement-breakpoint
ALTER TABLE "judge_versions" ALTER COLUMN "polarity" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."judge_polarity";--> statement-breakpoint
CREATE TYPE "public"."judge_polarity" AS ENUM('passes', 'fails');--> statement-breakpoint
ALTER TABLE "judge_versions" ALTER COLUMN "polarity" SET DATA TYPE "public"."judge_polarity" USING "polarity"::"public"."judge_polarity";--> statement-breakpoint

-- Safe only because of the guard above, and the inference is worth writing down: the CHECK
-- dropped three statements ago guaranteed `weight IS NULL` exactly when
-- `polarity = 'does_not_score'`, so a database with no such rows has no null weights. That
-- is the only thing standing between this statement and a migration that aborts.
ALTER TABLE "judge_versions" ALTER COLUMN "weight" SET NOT NULL;--> statement-breakpoint

-- Presence is now the column's own NOT NULL (ADR-0035); this is the separate half. Zero is
-- representable and still meaningless — a judge weighted zero takes no share of the score
-- and cannot move it. Renamed because `weight_matches_polarity` names a relationship that
-- no longer exists, and a constraint whose name lies is worse than one that is verbose.
ALTER TABLE "judge_versions" ADD CONSTRAINT "judge_versions_weight_positive" CHECK ("judge_versions"."weight" > 0);
