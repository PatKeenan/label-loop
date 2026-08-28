-- The attempt ledger, and the column that makes the follow-up job idempotent.
--
-- `job_attempts` is ours rather than pg-boss's (ADR-0017): reading a queue's private
-- tables to answer "how many times has this run" is what turns "we can replace the queue
-- on evidence" (ADR-0006) into a claim nobody can act on.
--
-- `traces.recorded_at` is nullable on purpose, twice over. It is what makes the handler's
-- write idempotent without a check-then-act — `WHERE recorded_at IS NULL` means Postgres
-- makes a re-delivery a no-op — and it is what makes a lost enqueue findable later, since
-- an evaluation whose follow-up never ran is a null rather than a silence.

CREATE TYPE "public"."job_attempt_status" AS ENUM('started', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "job_attempts" (
	"job_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"queue" text NOT NULL,
	"trace_id" text,
	"request_id" text NOT NULL,
	"status" "job_attempt_status" NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_attempts_job_id_attempt_pk" PRIMARY KEY("job_id","attempt")
);
--> statement-breakpoint
ALTER TABLE "traces" ADD COLUMN "recorded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_attempts" ADD CONSTRAINT "job_attempts_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_attempts_trace_idx" ON "job_attempts" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "job_attempts_queue_started_idx" ON "job_attempts" USING btree ("queue","started_at");