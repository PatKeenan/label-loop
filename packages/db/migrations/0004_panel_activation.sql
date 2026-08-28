-- Activation becomes a pointer rather than "the highest version number".
--
-- Statement order is hand-corrected here. drizzle-kit emitted the foreign key BEFORE the
-- unique constraint it references, which Postgres rejects ("there is no unique constraint
-- matching given keys") — the generator does not order constraint additions against each
-- other. Worth knowing: a generated migration is a draft, and this one does not run as
-- written.

ALTER TABLE "panel_versions" ADD CONSTRAINT "panel_versions_panel_id_id_key" UNIQUE("panel_id","id");--> statement-breakpoint
ALTER TABLE "panels" ADD COLUMN "current_version_id" text;--> statement-breakpoint
ALTER TABLE "panels" ADD CONSTRAINT "panels_current_version_fk" FOREIGN KEY ("id","current_version_id") REFERENCES "public"."panel_versions"("panel_id","id") ON DELETE no action ON UPDATE no action;
