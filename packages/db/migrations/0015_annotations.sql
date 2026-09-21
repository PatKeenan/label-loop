-- ADR-0066: the first annotation is acceptable / not acceptable plus a note.
--
-- APPEND-ONLY BY GRANT, the treatment `audit_events` gets in 0002 and the immutable versions
-- get in 0005. A changed mind is a new row, so the app role never needs UPDATE or DELETE here —
-- and a guarantee enforced by Postgres is a different claim from one enforced by remembering.
-- The INSERT and SELECT it does hold arrive through the default privileges set in 0000 and 0010;
-- only the removal is explicit. Proven by a test asserting SQLSTATE 42501, not by this comment.
CREATE TYPE "public"."annotation_outcome" AS ENUM('acceptable', 'not_acceptable', 'skipped');--> statement-breakpoint
CREATE TABLE "annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"panel_version_id" text NOT NULL,
	"annotator_id" text NOT NULL,
	"outcome" "annotation_outcome" NOT NULL,
	"note" text,
	"sampler" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotations_id_prefix" CHECK ("annotations"."id" ~ '^ann_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "annotations_note_rules" CHECK (("annotations"."outcome" = 'not_acceptable' AND "annotations"."note" IS NOT NULL AND length(btrim("annotations"."note")) > 0)
          OR ("annotations"."outcome" = 'acceptable')
          OR ("annotations"."outcome" = 'skipped' AND "annotations"."note" IS NULL)),
	CONSTRAINT "annotations_note_length" CHECK ("annotations"."note" IS NULL OR length("annotations"."note") <= 280)
);
--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_panel_version_id_panel_versions_id_fk" FOREIGN KEY ("panel_version_id") REFERENCES "public"."panel_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotations" ADD CONSTRAINT "annotations_annotator_id_user_id_fk" FOREIGN KEY ("annotator_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "annotations_trace_idx" ON "annotations" USING btree ("trace_id");--> statement-breakpoint
CREATE INDEX "annotations_panel_annotator_idx" ON "annotations" USING btree ("panel_id","annotator_id");--> statement-breakpoint
CREATE INDEX "annotations_panel_created_idx" ON "annotations" USING btree ("panel_id","created_at");--> statement-breakpoint
-- The whole point of the table shipping this way rather than being tidied later.
REVOKE UPDATE, DELETE ON annotations FROM labelloop_app;
