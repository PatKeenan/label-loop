-- ADR-0073 / ADR-0074, the CONTRACTION. The one irreversible step of the native-shapes
-- change, and the reason it is last: phases 1 through 4 shipped and were verified first, and
-- until this migration ran, reverting any of them left every row readable through `artifact`.
--
-- Nothing is lost that is not already carried: 0013 copied `artifact` into `output` (as a JSON
-- string, byte for byte) and `context` into `reference`, and every row written since has
-- dual-written both. `output` can therefore take NOT NULL — checked as 0 nulls across 4,610
-- rows before this was written, and the constraint itself refuses to apply if that is ever
-- untrue. No row is deleted here; only two columns leave.
ALTER TABLE "traces" ALTER COLUMN "output" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "traces" DROP COLUMN "artifact";--> statement-breakpoint
ALTER TABLE "traces" DROP COLUMN "context";