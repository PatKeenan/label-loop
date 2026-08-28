-- The append-only guarantee (CONVENTIONS.md "Data rules"), and the single deliberate
-- exception to the blanket DML grant in 0000.
--
-- `audit_events` is the one table where "nobody edited this" has to be true rather than
-- believed. Enforcing it in application code enforces nothing: the enforcement and the
-- thing being enforced live in the same process, so any bug, any script, any 2am psql
-- session holding the app's credentials can quietly rewrite history. Revoking the
-- privilege moves the guarantee to Postgres, where the answer to "how do you know?" is a
-- permission rather than a promise — and `audit-events.test.ts` asserts it by trying.
--
-- Recorded as an exception rather than as a pattern: every other table keeps full DML,
-- because immutability that is not needed is only a future migration re-granting it.

REVOKE UPDATE, DELETE ON audit_events FROM labelloop_app;
