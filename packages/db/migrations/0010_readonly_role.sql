-- ADR-0045: a third role, `labelloop_readonly`, so a dashboard cannot write. And the index
-- the per-key panel it exists for will need (ADR-0042).
--
-- The role is CREATED by `db:bootstrap` as a superuser; everything it can actually do is
-- granted here, by the migrator, where a privilege change is reviewable as a privilege
-- change. Forward-only, no down migration (ADR-0006).
--
-- **BOTH HALVES, and the second is the one that is easy to forget.** `ALTER DEFAULT
-- PRIVILEGES` only ever covers objects created AFTER it runs, so a role introduced at
-- migration 10 is on the wrong side of every table created in 1 through 9.
-- `0000_privileges.sql` already documents this exact trap — it needed an explicit
-- `GRANT SELECT ON ALL TABLES` for `drizzle.__drizzle_migrations`, because that table is
-- created before the first migration runs. Defaults alone would leave this role able to
-- read only the tables a FUTURE migration adds, which is the emptiest possible dashboard
-- and a bug that looks like a Grafana problem for a week.

-- Half one: everything that exists right now.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO labelloop_readonly;--> statement-breakpoint
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO labelloop_readonly;--> statement-breakpoint

-- Half two: everything a later migration creates. Run by the migrator, which is the role
-- that will create those tables — default privileges are per grantor, so setting them as
-- anyone else would silently cover nothing.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO labelloop_readonly;--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON SEQUENCES TO labelloop_readonly;--> statement-breakpoint

-- NO grant on the `drizzle` schema, deliberately. The app role reads
-- `__drizzle_migrations` because `/readyz` reports whether migrations are current; a
-- dashboard has no such question, and a role that can only SELECT should still only be
-- able to SELECT the things it has a reason to.
--
-- And nothing here needs a special case for `audit_events`. The append-only invariant
-- holds for this role BY CONSTRUCTION — a SELECT-only grant cannot violate it — which is
-- exactly the kind of "by construction" that `roles.test.ts` asserts anyway.

-- The index the per-key usage panel needs (ADR-0042, and the plan's open question 2,
-- answered here rather than deferred to the phase that draws the panel).
--
-- `traces.api_key_id` has existed since `0001_initial_schema.sql` with a foreign key and
-- NO index. The three indexes on this table lead with `org_id`, `panel_id` and
-- `request_id`, so none of them can serve "usage by key over the last N hours" — the
-- friendliest dashboard in the repo would be the slowest query in it, run every fifteen
-- seconds against the hot path's own database.
--
-- Ordered `(api_key_id, created_at)` rather than the reverse: the leading column is what
-- the query GROUPs by, and the trailing one bounds the window inside each key.
--
-- The usual objection to that order is that a btree cannot be used when the leading column
-- has no predicate — which would matter here, because the panel filters on TIME and groups
-- by key. Postgres 18 added btree skip scan, and this stack runs 18.6. Checked rather than
-- assumed, against 200k rows over 8 keys:
--
--   SELECT api_key_id, count(*) FROM ... WHERE created_at > now() - interval '30 minutes'
--     GROUP BY api_key_id;
--   -> Bitmap Index Scan on (api_key_id, created_at)
--        Index Cond: (created_at > ...)          -- no leading-column condition needed
--
-- So one index serves both shapes: the panel's group-by-over-a-window, and the ordinary
-- single-key lookup where the leading column IS present. On a Postgres older than 18 this
-- would want the columns the other way round, or a second index.
CREATE INDEX "traces_api_key_created_idx" ON "traces" USING btree ("api_key_id","created_at");
