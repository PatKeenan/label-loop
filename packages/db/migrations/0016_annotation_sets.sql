-- ADR-0079/0080/0082/0086: a curated, snapshotted selection of one panel's traces, assigned
-- to people. Three tables, because the set is a name and a lifecycle, its TRACES are a
-- snapshot that only grows, and its ANNOTATORS are assignments that are stamped, never deleted.
--
-- TWO COLUMNS THAT ARE DELIBERATELY ABSENT, and their absence is the decision:
--   * `annotation_sets.completed_at` — done is DERIVED (every CURRENTLY assigned annotator has
--     answered every trace), because a stored flag would go on saying "done" the moment a third
--     annotator is assigned to a finished set, when it genuinely is not done any more (ADR-0086).
--   * a membership count on `annotation_sets` — derivable, and a count cached beside an
--     append-only join table goes wrong silently.
--
-- `annotation_set_traces` is APPEND-ONLY BY GRANT, the treatment `audit_events` (0002) and
-- `annotations` (0015) get. A picker resolves once and writes rows; what a past annotation pass
-- covered must stay reconstructible (ADR-0003), which a re-evaluating query destroys. The
-- other two tables keep UPDATE: `archived_at` and `unassigned_at` are stamps a person writes.
-- Proven by a test asserting SQLSTATE 42501, not by this comment.
CREATE TYPE "public"."annotation_set_strategy" AS ENUM('manual', 'latest_n', 'earliest_n', 'random_n');--> statement-breakpoint
CREATE TABLE "annotation_set_annotators" (
	"annotation_set_id" text NOT NULL,
	"user_id" text NOT NULL,
	"is_dictator" boolean DEFAULT false NOT NULL,
	"assigned_by" text NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unassigned_at" timestamp with time zone,
	CONSTRAINT "annotation_set_annotators_annotation_set_id_user_id_pk" PRIMARY KEY("annotation_set_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "annotation_set_traces" (
	"annotation_set_id" text NOT NULL,
	"trace_id" text NOT NULL,
	"strategy" "annotation_set_strategy" NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" text NOT NULL,
	CONSTRAINT "annotation_set_traces_annotation_set_id_trace_id_pk" PRIMARY KEY("annotation_set_id","trace_id")
);
--> statement-breakpoint
CREATE TABLE "annotation_sets" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"name" text NOT NULL,
	"created_by" text NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "annotation_sets_id_prefix" CHECK ("annotation_sets"."id" ~ '^aset_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "annotation_set_annotators" ADD CONSTRAINT "annotation_set_annotators_annotation_set_id_annotation_sets_id_fk" FOREIGN KEY ("annotation_set_id") REFERENCES "public"."annotation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_set_annotators" ADD CONSTRAINT "annotation_set_annotators_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_set_annotators" ADD CONSTRAINT "annotation_set_annotators_assigned_by_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_set_traces" ADD CONSTRAINT "annotation_set_traces_annotation_set_id_annotation_sets_id_fk" FOREIGN KEY ("annotation_set_id") REFERENCES "public"."annotation_sets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_set_traces" ADD CONSTRAINT "annotation_set_traces_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_set_traces" ADD CONSTRAINT "annotation_set_traces_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_sets" ADD CONSTRAINT "annotation_sets_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_sets" ADD CONSTRAINT "annotation_sets_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "annotation_sets" ADD CONSTRAINT "annotation_sets_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "annotation_set_one_dictator_key" ON "annotation_set_annotators" USING btree ("annotation_set_id") WHERE "annotation_set_annotators"."is_dictator" AND "annotation_set_annotators"."unassigned_at" IS NULL;--> statement-breakpoint
CREATE INDEX "annotation_set_annotators_user_idx" ON "annotation_set_annotators" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "annotation_set_traces_set_added_idx" ON "annotation_set_traces" USING btree ("annotation_set_id","added_at");--> statement-breakpoint
CREATE UNIQUE INDEX "annotation_sets_panel_name_key" ON "annotation_sets" USING btree ("panel_id",lower("name"));--> statement-breakpoint
CREATE INDEX "annotation_sets_panel_idx" ON "annotation_sets" USING btree ("panel_id");
--> statement-breakpoint
-- The snapshot only ever grows. Rows arrive; nothing edits or removes one.
REVOKE UPDATE, DELETE ON annotation_set_traces FROM labelloop_app;
