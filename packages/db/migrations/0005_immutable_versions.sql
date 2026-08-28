-- Immutable versions, enforced by Postgres rather than by convention (ADR-0003).
--
-- Until now "editing creates version n+1, never mutates" was true for two soft reasons:
-- no code did it, and there is no mutable column on either row to update. Both are
-- conventions. The app role could still have run
--   UPDATE panel_versions SET threshold = 0.9 WHERE id = '...'
-- and Postgres would have allowed it — a bug, a maintenance script, or anyone holding the
-- app credentials could silently rewrite the configuration a score timeline is plotted
-- against. The whole eval story rests on "agreement per immutable version"; if a threshold
-- or a rubric can move underneath it, every timeline is suspect and "aligned at kappa 0.81"
-- loses its anchor.
--
-- This widens what 0002 called the single deliberate exception, and does so knowingly: the
-- append-only audit log and the immutable version are the same class of claim, so they get
-- the same class of enforcement.
--
-- Two things checked before committing to it. Cascading deletes still work — a referential
-- action runs with the privileges of the table owner, not the caller, so deleting an org
-- still cleans up its versions even though the app role cannot delete them directly. And
-- activation stays possible, because the pointer added in 0004 lives on `panels`, which
-- keeps UPDATE. An `is_current` flag on the version row would have been incompatible with
-- this migration; the pointer is what lets both decisions hold at once.
--
-- Cost accepted: a column that legitimately mutates later — `retired_at`, a `notes` field —
-- needs a migration to re-grant. That is the correct amount of friction for reopening this.

REVOKE UPDATE, DELETE ON panel_versions FROM labelloop_app;--> statement-breakpoint
REVOKE UPDATE, DELETE ON judge_versions FROM labelloop_app;
