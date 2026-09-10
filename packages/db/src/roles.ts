/**
 * The three database roles, named once (CONVENTIONS.md "Data rules"). A migrator that owns
 * DDL and runs migrations; an app role the API connects with that holds DML only and can
 * never alter schema; and a readonly role that can only SELECT.
 */
export const MIGRATOR_ROLE = 'labelloop_migrator'
export const APP_ROLE = 'labelloop_app'
/**
 * The credential Grafana connects with (ADR-0045). It exists because neither of the other
 * two is right for a dashboard: the migrator owns DDL, and the app role can `INSERT` and
 * `DELETE` — which is precisely the capability the migrator/app split exists to withhold.
 *
 * **It is given to Grafana and withheld from the API.** `apps/api/src/config.ts` cannot
 * express it, the same treatment the migrator credential already gets and for the same
 * reason: a role the API cannot name is a role a bug cannot reach for.
 */
export const READONLY_ROLE = 'labelloop_readonly'

/**
 * The single deliberate exception to the blanket DML grant. `audit_events` is append-only,
 * and it is Postgres that enforces it rather than application code — which is the
 * difference between an append-only claim and an append-only guarantee.
 */
export const APPEND_ONLY_TABLES = ['audit_events'] as const
