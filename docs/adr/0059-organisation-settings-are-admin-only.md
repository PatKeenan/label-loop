# ADR-0059: Organisation settings are admin-only, and absent until they hold something

**Status:** Accepted · **Date:** 2026-09-14 · **Milestone:** M4 (decided), M8 (enforced)

## Decision
Organisation-level administration — Audit log and Billing, and members management if it is ever scheduled — lives under **Organisation settings** at the foot of the console sidebar, is shown **only to `admin`** in the active org, and is **not rendered at all until M8**, when the first of those screens ships. M8 guards each route with `requireRole('admin')`; hiding the entry mirrors that guard and never replaces it.

## Context
PRODUCT.md 5.1 lists the roles and 5.12 the audit log, but says nothing about who sees billing or audit history. The stakeholder's reasoning, at the review of `console-shell.html`: in an organisation that has deployed LabelLoop, most developers should never see billing or the audit log, so placing them in the main nav makes the nav vary by role in a way that looks broken, and placing them behind a settings entry lets them simply not exist for people who cannot use them.

Not rendering the entry at M4 follows from the same argument: both screens are M8, so an M4 admin would open a settings page with nothing live in it.

**Alternative named and left open to widen later:** an audit log is often wanted by a compliance reader who is not an admin. Admin-only is the default; a read-only audit role would be an amendment, not a reversal.

Plan: `thoughts/shared/plans/complete/2026-09-11_m4-console-auth.md` (phase 6) · Record: `mockups/CONSOLE_FLOW.md` §3, §8 (R4)
