# ADR-0064: A role grants capabilities; the surface you land on is a preference

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5 (decided at the close of M4)
**Refines:** PRODUCT.md §5.1/§5.5 ("role determines the surface a user lands on") · **Builds on:** ADR-0014

> Stub from `/log_decision`. Rationale is in `thoughts/shared/progress/decisions-log.md`
> (2026-09-18T20:00Z). Expand when the M5 members-and-annotation plan settles the mechanism.

## Decision
A role answers **what you may do**, not **what you see**. Admins and engineers may annotate;
the annotation surface is a view a staff member can choose, alongside the console. Annotators
keep exactly their current limits: no keys, no panel authoring, no console surfaces beyond what
annotation needs. The server enforces **capabilities** per role (the permission a route needs),
replacing role lists such as `requireRole('admin', 'engineer')`; the console mirrors the same
map and never replaces the server's check.

Where a user **lands** stays role-derived by default (PRODUCT.md §5.5's role-adaptive routing
holds) — it is the *exclusivity* that is dropped, not the default.

## Context
PRODUCT.md §5.5 made role-adaptive surfaces "the product", and the M4 console implemented them
as exclusive: an annotator sees only the annotator state, a developer only the console. Asked
at the close of M4 whether a developer could also annotate, the stakeholder's answer was that
these are views and a preference, and that the harm worth preventing is an annotator reaching
credentials — not a developer reaching an annotation queue. In small teams the developer is
often the first expert; forcing a second account on them is friction with no safety benefit.

Alternatives considered: exclusive roles (status quo); a SET of roles per membership (schema
change on `org_members`, plus a rule for which role chooses the landing surface).

## Consequences
- **No schema change is required** for this decision: `org_members.role` (ADR-0014) stays a
  single value, and the engineer/admin roles simply include the annotation capability.
- `requireRole` gives way to a permission check. Candidate mechanism: better-auth's standalone
  `createAccessControl` (`better-auth/plugins/access` — pure, no tables), shared by server and
  console the way `@labelloop/contracts` `names.ts` shares name rules. Not the organization
  plugin, which ADR-0048 declined and which collides with ADR-0014 and ADR-0047.
- **Member management becomes a prerequisite of M5** — someone has to be able to put an
  annotator into an org. Its shape (direct add vs. email invitations) is the research's to
  settle.
- Every annotation row still carries `annotator_id` (CLAUDE.md hard rule) whatever role the
  annotator holds, so a developer's annotations are attributable exactly like an SME's.
