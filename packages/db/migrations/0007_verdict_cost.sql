ALTER TABLE "trace_verdicts" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "trace_verdicts" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "trace_verdicts" ADD COLUMN "reasoning_tokens" integer;--> statement-breakpoint
ALTER TABLE "trace_verdicts" ADD COLUMN "cost_usd" numeric(16, 10);--> statement-breakpoint
ALTER TABLE "trace_verdicts" ADD COLUMN "cost_priced" boolean DEFAULT false NOT NULL;