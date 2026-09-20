-- ADR-0073: evaluate takes four roles in the caller's own shapes — input, output, reference,
-- metadata — instead of a string `artifact` and a flat string-map `context`.
--
-- EXPAND ONLY (ADR-0074). Nothing is dropped and no row is removed: four nullable columns
-- are added, `artifact` is widened to nullable, and the application dual-writes `artifact`
-- until the new shape has been lived with, so reverting the code that reads these columns
-- leaves every row readable. The contraction is a later, separate migration.
ALTER TABLE "traces" ALTER COLUMN "artifact" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "output" jsonb;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "reference" jsonb;--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
-- The backfill. A legacy artifact was always text, so it becomes a JSON STRING output —
-- exactly what a caller sending the same text today would store. Its context was facts the
-- judges read, so it becomes `reference`. `input` stays NULL: a pre-migration trace never
-- recorded what its agent was given, and inventing one from `context` would be a guess
-- stored as a fact. `metadata` stays NULL for the same reason.
--
-- Guarded on `output IS NULL` so the statement touches only rows written before this
-- migration, and re-running it would change nothing.
UPDATE "traces"
SET "output" = to_jsonb("artifact"), "reference" = "context"
WHERE "output" IS NULL;
