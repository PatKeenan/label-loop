# ADR-0045: A third database role, read-only, so a dashboard cannot write

**Status:** Accepted · **Date:** 2026-09-08 · **Milestone:** M3
**Amends:** CONVENTIONS.md "Data rules" — two roles becomes three

> **Stub.** Created by `/approve_plan` from the "Decisions made" section of
> `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`. Expand if the decision is challenged or its consequences grow.

## Decision

**`labelloop_readonly` joins `labelloop_migrator` and `labelloop_app`: SELECT only, and it is
the credential Grafana connects with.** Stakeholder decision, 2026-09-08, choosing it over
reusing the app role.

**The credential is given to Grafana and withheld from the API.** `config.ts` must not be able
to express it — the same treatment the migrator credential already gets, on the same reasoning:
a role the API cannot name is a role a bug cannot reach for.

## Context

[ADR-0042](0042-per-key-usage-comes-from-postgres.md) points the per-key dashboard at Postgres,
so Grafana needs a database credential. Neither existing role fits: the migrator owns DDL, and
the app role holds DML — handing a dashboard the ability to `INSERT` or `DELETE` is precisely
the capability the migrator/app split exists to withhold.

## Consequences

- **CONVENTIONS' two-role invariant becomes three**, with the reason recorded beside it. The
  shape of the rule is unchanged: privilege is enforced by Postgres grants, never by trusting
  the client.
- **The migration needs both halves, and the second is easy to forget.** `ALTER DEFAULT
  PRIVILEGES` only covers tables created after it runs, so a role added at migration 10 is on
  the wrong side of every table created in 1 through 9 and needs an explicit
  `GRANT SELECT ON ALL TABLES` as well. `0000_privileges.sql` already documents this exact
  trap for `drizzle.__drizzle_migrations`.
- **Asserted, not assumed**: `roles.test.ts` gains cases proving the role can SELECT and cannot
  INSERT, UPDATE, DELETE or issue DDL, on SQLSTATE `42501` like the existing privilege tests.
- `audit_events` stays append-only for this role by construction — a SELECT-only grant cannot
  violate it — and is asserted anyway.
- A third connection string in `.env.example` and one more role for `db:bootstrap` to create.

Plan: `thoughts/shared/plans/approved/2026-09-08_m3-observability.md`
Provenance: `thoughts/shared/research/2026-09-08_m3-observability.md`
Related: ADR-0042, ADR-0006 · Amends: CONVENTIONS.md "Data rules"
