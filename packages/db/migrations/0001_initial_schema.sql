CREATE TYPE "public"."aggregation_policy" AS ENUM('weighted_threshold');--> statement-breakpoint
CREATE TYPE "public"."api_key_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."judge_polarity" AS ENUM('passes', 'fails', 'does_not_score');--> statement-breakpoint
CREATE TYPE "public"."judge_type" AS ENUM('code', 'llm');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('admin', 'engineer', 'annotator', 'guest_expert');--> statement-breakpoint
CREATE TYPE "public"."verdict_status" AS ENUM('evaluated', 'skipped_sampling', 'failed', 'error');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"last4" text NOT NULL,
	"status" "api_key_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_id_prefix" CHECK ("api_keys"."id" ~ '^key_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"data" jsonb,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_id_prefix" CHECK ("audit_events"."id" ~ '^aud_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "judge_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"judge_id" text NOT NULL,
	"version" integer NOT NULL,
	"type" "judge_type" NOT NULL,
	"polarity" "judge_polarity" NOT NULL,
	"weight" real,
	"required" boolean DEFAULT false NOT NULL,
	"question" text NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_versions_id_prefix" CHECK ("judge_versions"."id" ~ '^jdv_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "judge_versions_version_positive" CHECK ("judge_versions"."version" >= 1),
	CONSTRAINT "judge_versions_weight_matches_polarity" CHECK (("judge_versions"."polarity" = 'does_not_score' AND "judge_versions"."weight" IS NULL)
          OR ("judge_versions"."polarity" <> 'does_not_score'
              AND "judge_versions"."weight" IS NOT NULL AND "judge_versions"."weight" > 0)),
	CONSTRAINT "judge_versions_model_matches_type" CHECK (("judge_versions"."type" = 'code' AND "judge_versions"."model" IS NULL)
          OR ("judge_versions"."type" = 'llm' AND "judge_versions"."model" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "judges" (
	"id" text PRIMARY KEY NOT NULL,
	"panel_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judges_id_prefix" CHECK ("judges"."id" ~ '^jud_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" "org_role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_id_prefix" CHECK ("orgs"."id" ~ '^org_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "panel_version_judges" (
	"panel_version_id" text NOT NULL,
	"judge_version_id" text NOT NULL,
	CONSTRAINT "panel_version_judges_panel_version_id_judge_version_id_pk" PRIMARY KEY("panel_version_id","judge_version_id")
);
--> statement-breakpoint
CREATE TABLE "panel_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"panel_id" text NOT NULL,
	"version" integer NOT NULL,
	"threshold" real NOT NULL,
	"aggregation_policy" "aggregation_policy" DEFAULT 'weighted_threshold' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panel_versions_id_prefix" CHECK ("panel_versions"."id" ~ '^pnv_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "panel_versions_version_positive" CHECK ("panel_versions"."version" >= 1),
	CONSTRAINT "panel_versions_threshold_range" CHECK ("panel_versions"."threshold" >= 0 AND "panel_versions"."threshold" <= 1)
);
--> statement-breakpoint
CREATE TABLE "panels" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "panels_id_prefix" CHECK ("panels"."id" ~ '^pnl_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
CREATE TABLE "trace_verdicts" (
	"trace_id" text NOT NULL,
	"judge_version_id" text NOT NULL,
	"status" "verdict_status" NOT NULL,
	"verdict" boolean,
	"passed" boolean,
	"rationale" text,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" real,
	"weight" real,
	"served_by" text,
	"latency_ms" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"raw_response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_verdicts_trace_id_judge_version_id_pk" PRIMARY KEY("trace_id","judge_version_id")
);
--> statement-breakpoint
CREATE TABLE "traces" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"panel_id" text NOT NULL,
	"panel_version_id" text NOT NULL,
	"api_key_id" text,
	"request_id" text NOT NULL,
	"artifact" text NOT NULL,
	"context" jsonb,
	"passed" boolean NOT NULL,
	"score" real NOT NULL,
	"complete" boolean NOT NULL,
	"threshold" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traces_id_prefix" CHECK ("traces"."id" ~ '^tr_[0-9A-HJKMNP-TV-Z]{26}$')
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judge_versions" ADD CONSTRAINT "judge_versions_judge_id_judges_id_fk" FOREIGN KEY ("judge_id") REFERENCES "public"."judges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "judges" ADD CONSTRAINT "judges_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_version_judges" ADD CONSTRAINT "panel_version_judges_panel_version_id_panel_versions_id_fk" FOREIGN KEY ("panel_version_id") REFERENCES "public"."panel_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_version_judges" ADD CONSTRAINT "panel_version_judges_judge_version_id_judge_versions_id_fk" FOREIGN KEY ("judge_version_id") REFERENCES "public"."judge_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_versions" ADD CONSTRAINT "panel_versions_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_verdicts" ADD CONSTRAINT "trace_verdicts_trace_id_traces_id_fk" FOREIGN KEY ("trace_id") REFERENCES "public"."traces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_verdicts" ADD CONSTRAINT "trace_verdicts_judge_version_id_judge_versions_id_fk" FOREIGN KEY ("judge_version_id") REFERENCES "public"."judge_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_panel_version_id_panel_versions_id_fk" FOREIGN KEY ("panel_version_id") REFERENCES "public"."panel_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traces" ADD CONSTRAINT "traces_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "audit_events_org_created_idx" ON "audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_subject_idx" ON "audit_events" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_key" ON "session" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "judge_versions_judge_version_key" ON "judge_versions" USING btree ("judge_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "judges_panel_slug_key" ON "judges" USING btree ("panel_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_slug_key" ON "orgs" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "panel_versions_panel_version_key" ON "panel_versions" USING btree ("panel_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "panels_org_slug_key" ON "panels" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "trace_verdicts_judge_version_idx" ON "trace_verdicts" USING btree ("judge_version_id","created_at");--> statement-breakpoint
CREATE INDEX "traces_org_created_idx" ON "traces" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "traces_panel_created_idx" ON "traces" USING btree ("panel_id","created_at");--> statement-breakpoint
CREATE INDEX "traces_request_id_idx" ON "traces" USING btree ("request_id");