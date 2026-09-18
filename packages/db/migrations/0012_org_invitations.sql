-- ADR-0065: membership by invitation, claimed on first sign-in against a VERIFIED email.
--
-- A new table and nothing else. Its grants arrive through the default privileges set in 0000
-- and 0010 (app: DML, readonly: SELECT) — unlike `audit_events`, an invitation is a stateful
-- row that is stamped accepted or revoked, so the app role's UPDATE is intended. It is never
-- deleted by the application; the org's cascade is the only thing that removes one.
CREATE TABLE "org_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" NOT NULL,
	"invited_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"accepted_by" text,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "org_invitations_id_prefix" CHECK ("org_invitations"."id" ~ '^inv_[0-9A-HJKMNP-TV-Z]{26}$'),
	CONSTRAINT "org_invitations_email_lowercase" CHECK ("org_invitations"."email" = lower("org_invitations"."email")),
	CONSTRAINT "org_invitations_accepted_pair" CHECK (("org_invitations"."accepted_at" IS NULL) = ("org_invitations"."accepted_by" IS NULL)),
	CONSTRAINT "org_invitations_one_ending" CHECK ("org_invitations"."accepted_at" IS NULL OR "org_invitations"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invitations" ADD CONSTRAINT "org_invitations_accepted_by_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_invitations_open_key" ON "org_invitations" USING btree ("org_id","email") WHERE "org_invitations"."accepted_at" IS NULL AND "org_invitations"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "org_invitations_email_idx" ON "org_invitations" USING btree ("email");