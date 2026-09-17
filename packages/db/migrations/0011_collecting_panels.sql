-- ADR-0060: a panel can COLLECT before it judges.
--
-- A panel with no judges captures the trace in full and convenes nobody, so there is no
-- verdict and no score. A score over zero judges is not 0, it is undefined — storing a 0
-- would put a number in the trace table that reads as a real result.
--
-- Widening only: every existing row keeps its value, and nothing is rewritten.
ALTER TABLE "traces" ALTER COLUMN "passed" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "traces" ALTER COLUMN "score" DROP NOT NULL;
