/**
 * The two database roles, named once (CONVENTIONS.md "Data rules"). A migrator that owns
 * DDL and runs migrations; an app role the API connects with that holds DML only and can
 * never alter schema.
 */
export const MIGRATOR_ROLE = 'labelloop_migrator'
export const APP_ROLE = 'labelloop_app'

/**
 * The single deliberate exception to the blanket DML grant. `audit_events` is append-only,
 * and it is Postgres that enforces it rather than application code — which is the
 * difference between an append-only claim and an append-only guarantee.
 */
export const APPEND_ONLY_TABLES = ['audit_events'] as const
