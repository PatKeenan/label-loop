-- Default privileges, set BEFORE the first table exists.
--
-- Ordering is the whole reason this is its own migration. `ALTER DEFAULT PRIVILEGES`
-- applies to objects created AFTER it runs, by the role that ran it — so it cannot live in
-- the migration that creates the tables and still cover them. It runs first, as
-- labelloop_migrator, and every table any later migration creates is granted automatically.
--
-- That automation is the point (CONVENTIONS.md "Data rules"): a per-migration GRANT would
-- eventually be forgotten, and a forgotten grant does not fail the migration — it fails in
-- production, on the one endpoint that touches the new table, at whatever hour it is first
-- called. The failure mode of getting this wrong is silent and delayed, which is exactly
-- the kind that deserves to be structural.

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO labelloop_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO labelloop_app;

-- Drizzle's own bookkeeping lives outside `public`. The app role never writes to it — it
-- only needs to READ the migration table for the `/readyz` "migrations current" check.
--
-- Note the explicit GRANT on existing tables rather than default privileges alone. The
-- migrator creates `drizzle.__drizzle_migrations` BEFORE it applies the first migration,
-- so by the time this file runs the table already exists — and ALTER DEFAULT PRIVILEGES
-- only ever covers objects created after it. Relying on the default alone would leave
-- `/readyz` unable to read the one table it needs, in a way that looks like a permissions
-- bug months later rather than an ordering one now.
CREATE SCHEMA IF NOT EXISTS drizzle;
GRANT USAGE ON SCHEMA drizzle TO labelloop_app;
GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO labelloop_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA drizzle GRANT SELECT ON TABLES TO labelloop_app;
