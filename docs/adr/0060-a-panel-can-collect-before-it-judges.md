# ADR-0060: A panel can collect before it judges

**Status:** Accepted · **Date:** 2026-09-15 · **Milestone:** M5

## Decision
A panel may exist in a **collecting** state: it accepts `/v1` calls, captures a trace for every
one, convenes **no judges**, and costs no provider tokens. The response says so explicitly — a
state on the decision, with `passed` and `score` null — rather than auto-passing. A panel leaves
the state by activating a version that convenes judges, which is an ordinary new panel version
(ADR-0003). The exact field names and the `evaluate` contract change are settled when M5 is
planned; what is decided here is that the state exists and is explicit.

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
- M4 is untouched: its wizard still creates judges, and the capability-gated model picker
  (ADR-0021) is unaffected.

Raised by the stakeholder, 2026-09-15, while reviewing what the M4 wizard should teach authors.
Plan: to be planned with M5 · Record: `thoughts/shared/progress/decisions-log.md`
