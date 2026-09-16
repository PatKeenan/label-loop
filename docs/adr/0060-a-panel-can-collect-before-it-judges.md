# ADR-0060: A panel can collect before it judges

**Status:** Accepted · **Date:** 2026-09-15 · **Milestone:** M4 *(moved from M5 the same day — see the amendment)*

## Decision
A panel may exist in a **collecting** state: it accepts `/v1` calls, captures a trace for every
one, convenes **no judges**, and costs no provider tokens. The response says so explicitly — a
state on the decision, with `passed` and `score` null — rather than auto-passing. A panel leaves
the state by activating a version that convenes judges, which is an ordinary new panel version
(ADR-0003). The exact field names are settled when M4's phase 8 is built; what is decided here
is that the state exists and is explicit.

## Context
**Judges cannot be authored before error analysis.** The product's own loop (PRODUCT.md §4) runs
traces → open coding → axial coding → judges → alignment: a team does not know its failure modes
until an expert has read its real traffic. Until now the product contradicted that at the first
step, because `services/evaluate.ts` refuses a panel with no judges (*"This panel version
convenes no judges"*), so a customer had to invent judges before a single trace could exist —
exactly the guesses the loop is designed to replace.

**The cost is already visible in this repository.** The seeded panel keeps `needs-human`, a judge
BUILD_SPINE M5 openly calls wrong under ADR-0036, and says why it survives: *"a panel with no
judges makes `evaluate` throw `NOT_FOUND`"*. We invented a judge we knew was invalid to satisfy a
technical requirement. A customer would hit the same wall on day one, and their bad judge would
not be labelled.

**Collecting is also the better open-coding surface.** `annotator-session`'s design withholds the
judge's verdict until after the annotator commits, to stop it anchoring them. In a collecting
panel there is no verdict to withhold, which is the cleanest form of the taxonomy-blind first
pass PRODUCT.md 5.5 asks for.

**Why not auto-pass.** A caller who wired the panel as a gate and receives `passed: true` ships
everything while believing it is protected. The opposite default — `passed: false` — blocks
everything. Neither is silently safe, so the state is explicit in the payload and visible in the
console; the documented reading during integration is "treat as a pass", which matches the
fail-open posture ADR-0040 already took for the limiter. A panel sitting in collecting mode
unnoticed is the failure this visibility exists to prevent.

## Consequences
- `evaluate`'s two `NOT_FOUND` refusals become a legitimate state; a panel version with no judges
  becomes representable, which the schema must permit.
- The `/v1` response contract gains the state and nullable `passed`/`score` at the decision level
  (per-judge fields are already nullable). This is a breaking-shaped change made before any
  external consumer exists.
- It depends on the **panel version n+1 write path**, which nothing currently schedules —
  leaving collecting mode *is* that write. The two belong in one piece of work.
- The demo narrative improves: create a panel → key → curl → watch the trace → annotate → the
  judges are derived from what actually went wrong, rather than guessed before any traffic.
- **The seeded panel's placeholder judge can be deleted when this ships**, closing the ADR-0036
  violation BUILD_SPINE M5 currently carries knowingly.
- **Superseded by the amendment below:** this originally read "M4 is untouched", on the
  assumption that M4's wizard would keep creating judges. It does not — see ADR-0061.

Raised by the stakeholder, 2026-09-15, while reviewing what the M4 wizard should teach authors.
Plan: M4 phase 8 · Record: `thoughts/shared/progress/decisions-log.md`

## Amendment — 2026-09-15, moved to M4
Recorded against M5 in the morning and **moved to M4 the same day**, when the stakeholder specified the creation flow: one step (name, slug, threshold), then the panel's own home as the onboarding surface — collecting state, progress toward the annotation threshold, and the integration snippet.

That flow cannot be built without this ADR. `POST /internal/panels` requires at least one judge, and `evaluate` refuses a judgeless panel, so approving the screen and leaving the ADR at M5 would have had phase 8 build the wizard its own review had just rejected. ADR-0061 is the other half of the same decision: judges are authored only from an eval pass, so a panel that has no judges yet is the normal state of a new panel rather than an edge case.

M4 therefore carries the contract change (an explicit state, `passed`/`score` nullable), the schema change making a judgeless version representable, and `evaluate` writing a trace without a fan-out. The panel version n+1 write path stays with the milestone that authors judges (M6).
