-- Role creation. Run by `bun run db:bootstrap` as a SUPERUSER, once per database.
--
-- This file holds exactly the things a superuser must do and nothing else. Everything a
-- migrator can do for itself lives in the migration stream instead, so the privileged
-- surface stays as small as it can be and is reviewable in one screen.
--
-- No passwords appear here. `db:bootstrap` sets each role's password from the password
-- already in DATABASE_URL / DATABASE_MIGRATION_URL, so the connection strings stay the
-- single source of truth and this file never has to hold a credential.
--
-- Idempotent by construction: re-running it is a no-op, which matters because it runs on
-- every `db:setup` and on every fresh CI database.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'labelloop_migrator') THEN
    CREATE ROLE labelloop_migrator LOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'labelloop_app') THEN
    CREATE ROLE labelloop_app LOGIN;
  END IF;
END
$$;

DO $$
BEGIN
  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO labelloop_migrator, labelloop_app',
    current_database()
  );
  -- CREATE on the DATABASE, which is a different privilege from owning a schema: it is
  -- what lets the migrator create new schemas. It needs one — Drizzle keeps its migration
  -- bookkeeping in a `drizzle` schema of its own, outside `public`.
  EXECUTE format(
    'GRANT CREATE ON DATABASE %I TO labelloop_migrator',
    current_database()
  );
END
$$;

-- The migrator owns the schema, which is what lets it issue DDL without being a superuser.
ALTER SCHEMA public OWNER TO labelloop_migrator;

-- The app role may enter the schema and nothing more. It gets no CREATE here and never
-- will: an app role without DDL means a SQL-injection bug cannot drop `traces`, and the
-- migrator/app split stops being a naming convention and starts being a privilege boundary.
GRANT USAGE ON SCHEMA public TO labelloop_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
