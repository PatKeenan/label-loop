# Parking Lot — ideas that fit no current milestone

- Deeper platform AI-security features (tenant-facing content moderation, injection
  scanning as a service) — deliberately out of scope under the shared-responsibility
  model; revisit only if productized as a judge template.
- Interview talking track: shared responsibility (AWS analogy) + judge-injection
  hardening + injection-detector showcase tenant = the AI-security answer.

## From the 2026-08-22 judge-as-a-service framing conversation
Full context: `thoughts/shared/research/2026-08-22_judge-as-a-service-reframe.md`.

- **Hosted execution of deterministic checks.** Failure modes that reduce to a schema
  assertion or a regex should become code checks rather than LLM judges (near-zero cost
  and latency, perfect precision by construction). The stakeholder's position is that
  LabelLoop should *host and run* that code so the whole loop — versioning, audit trail,
  metrics, dashboard — stays in one place, rather than the check living in the customer's
  codebase where we cannot see it. The product logic is sound. **The cost is that
  executing arbitrary customer code is a security-boundary product in its own right**
  (sandbox escape, resource exhaustion, network egress, secret exfiltration), and it
  conflicts with the deployment story in ADR-0009/0013.
  **Cheaper path worth evaluating first:** do not execute arbitrary code — execute
  *constrained declarative* checks (JSON Schema, regex, JSONPath assertions, or a small
  expression language such as CEL or JSONLogic). That covers "does this match the
  structure" essentially completely, with no sandbox and no escape risk, and stays fully
  hosted. Arbitrary code execution then becomes a later escalation only if declarative
  proves insufficient. If it ever is built, a sandbox runtime is a **STACK_DECISIONS row
  and needs an ADR** — it shapes architecture and hosting.

- **AI-authored deterministic checks.** An in-app feature where an SME observation such as
  "doesn't fit the structure" is turned by the platform into a generated check that the
  developer reviews and approves. Compelling demo and a natural fit with the axial-coding
  triage step. Depends on the item above for execution, but not for authoring — generating
  a JSON Schema is useful even if the customer runs it themselves.

- **Rubric-driven auto-optimisation.** Automatically optimising prompts or configs against
  the rubric and the expert's evaluations (DSPy-shaped). Fits no current milestone; named
  here so it is not silently absorbed into M6/M7.

## Durable execution for the judge fan-out (raised 2026-08-22)
A panel evaluation is N independent LLM calls, and N grows. The failure modes are the
interesting part and none of them are answered yet:

- **Partial success.** Eight of eleven return. *Contract-level answer already decided
  (ADR-0019): return the partial and mark it `complete: false`.* What is NOT decided is
  the **execution** behaviour behind it — retry the missing two inline, queue them, or
  abandon them.
- **Retry policy per judge.** How many attempts, what backoff, and does a retried judge
  still count toward the same trace or open a new one.
- **Token limits and truncation.** A judge that exceeds context is `failed`, but the
  handling — truncate the artifact, drop context, fail fast — is a product decision with
  a correctness cost either way.
- **Spend control.** N judges × retries × traffic is a cost multiplier that needs a
  ceiling before it needs an invoice.
- **Idempotency across the fan-out.** Re-delivering a panel evaluation must not re-charge
  or re-run judges that already answered.

**Candidate technologies: Temporal or Inngest** for durable execution. Both would be
**STACK_DECISIONS rows requiring stakeholder sign-off and an ADR** — they shape
architecture, not just implementation, and D4 already chose pg-boss. The same discipline
ADR-0006 applied to Redis applies here: do not adopt until the failure modes above are
demonstrated to need it, ideally with k6 evidence from M2. pg-boss plus hand-rolled
retry (ADR-0012) may well be sufficient for M0–M6; the fan-out only gets interesting at
M6–M7 scale.

Genuinely senior-engineering territory, and worth building deliberately rather than
discovering under load — which is an argument for scheduling it, not for pre-adopting a
framework.

## From the 2026-08-23 cross-thread reconciliation
Full context: `thoughts/shared/research/2026-08-23_cross-thread-reconciliation.md`.

- **Cross-org grants — PINNED, not rejected.** A consuming org seeing subscribed external
  panels inside its own tool list, alongside its own. Parked because the B2B beachhead does
  not need it: an external client needs a key, a meter and an invoice, not an identity in
  our system. The use case is nonetheless real — a marketing agency with its own panels
  also wanting to consume someone else's — so this is a "not yet" with the case recorded.
- **Panel-as-sensor alerting.** Per-panel versioned alert rules over the verdict stream:
  sliding-window fail rates, taxonomy-code spikes (diagnostic, not merely alarming),
  per-judge latency/error/attempt thresholds, drift and staleness nags. Signed webhooks
  (HMAC, retry with backoff, dead-letter) — which is M2's resilience work pointed outbound,
  not new machinery — with an **alert-to-annotation loop** so an incident becomes data
  collection.
- **Anti-distillation.** Per-call pricing, a ToS no-training clause, rate and quota limits,
  and anomaly detection over the verdict stream (volume spikes, coverage-sweeping input
  distributions, near-duplicate perturbations) → suspend key. Parked while panels are
  private; **stops being parkable once external paying consumers exist**. The honest
  position is that the real moat is continuous alignment: a clone is a frozen snapshot that
  goes stale with no realignment loop and no named experts.
- **MCP distribution.** One platform-level remote server with dynamic per-user tool lists,
  each accessible panel auto-described from its judges — never per-panel servers. A thin
  adapter over the same `/v1` gateway.
- **API surface split**, with a dashboard-first promotion rule: read-only analytics as MCP
  tools, audit as the M8 compliance export, management CRUD parked until enterprise pull.
  Nothing is built public-first; queries earn the public API by proving themselves in the
  dashboard.
- **Marketplace surface.** Expert bios backed by platform-generated provenance, cohorts as
  the human mirror of a panel, and the GitHub work-graph analogy — panel versions as
  releases, alignment history as commit log, "git blame for judgment" — with two deliberate
  breaks from GitHub: weight by quality rather than volume, and contributions pay.
- **Multi-task warm-start** for data-poor judges, **auto-suggested adapter pinning**,
  **BERT-class encoders** as a rung below small generative fine-tunes, **trajectory-level
  evaluation**, and **white-label/custom domains** — all named in the source session as
  parked, and parked here too.

## Trace detail — one record, full page (raised 2026-09-16)

> **Built at M4 as a DRAWER, 2026-09-18** (M4 plan, Deviation 75): `GET /internal/traces/:id`,
> staff-only, and a right-side drawer from any trace row. What is still parked from the entry
> below: **audit-on-read** (M8), **the annotator's view of one trace** (M5, where harvest
> blocker 2 is decided), and **`raw_response`**, which the drawer does not render. The entry is
> kept as the reasoning the build started from.

Clicking a trace row to read what went in and what each judge said. Raised by the
stakeholder while walking through the M4 phase 7 shell; recorded here because
`mockups/CONSOLE_FLOW.md` §3 lists both this and the trace explorer as **Unscheduled**, and
no milestone owns either.

**The capture side is already done, and that is the part that would have been expensive.**
Because we are the inference path for judge calls (ADR-0001), every field this screen needs
is written server-side today: `traces.artifact` (the caller's own output — we never generated
it), `traces.context` (their opaque string map, where a DECIDING agent's output lives per
ADR-0037), `panel_version_id` pinning the exact configuration that judged it, and one
`trace_verdicts` row per judge carrying `rationale` — the reasoning, written before the
verdict — plus `reasons[]`, `verdict`, `confidence`, `served_by`, `latency_ms`, `attempts`
and token counts. Nothing needs to be captured differently. What is missing is a read
(`GET /internal/traces` returns only the decision columns) and a screen.

**Three things make it more than a UI job, and they are why it is parked rather than
scheduled:**

- **The role guard does not exist yet.** `GET /internal/traces` is the one internal route
  with no `requireRole` (M4 plan, Deviation 32), so an annotator's session can read it. That
  is harmless while the rows carry no verdicts; a detail page carrying rationale and
  confidence makes it material.
- **Harvest blocker 2 is open: whether confidence is withheld from annotators.** Showing a
  judge's confidence to an SME before they annotate biases the annotation, which is the
  input the whole flywheel runs on. This screen cannot be designed without answering it,
  and the answer may be that the engineer console and the annotator surface show different
  fields of the same record.
- **M5 already builds a one-trace-at-a-time view**, on the annotator surface
  (`annotator-session`): one trace, agree/correct, failure note. Two full views of one record
  is a divergence risk, and the honest question is whether this is a second screen or the
  engineer's read of the same one. PRODUCT.md 5.5 makes them deliberately different
  experiences, so "share the component" is not automatically the answer.

**The cheaper increment, and it may be enough:** the M4 plan's open question 2 — still open,
and phase 8's to decide — asks whether the trace table gets raw payloads **expanding in
place** rather than inline. Expanding rows inside the existing table needs no new route, no
new screen and no third sidebar level, and it answers "what did the agent send" without
committing to a full page. Its own unresolved constraint is the harvest's Q1: ten columns do
not fit a laptop viewport.

**One thing to decide deliberately if it is ever built:** `artifact` is the customer's own
production data, and a full-page view makes it the most exposed thing in the console.
Redaction, retention and whether reading one is itself an audit event are all unscheduled —
M8 owns the audit log, and this would be a candidate writer.

## Organisation creation is unmetered (raised 2026-09-18, ADR-0063)

M4 lets any account that belongs to no organisation create one — the fix for new sign-ins
landing on a dead end. In production that is any GitHub account, with no quota, no rate limit
of its own, and no review. Fine for a portfolio deployment; not for a real one.

**Promote with M8's billing work**, which already owns quotas: an org limit per account, and
closing the race ADR-0063 accepts (two concurrent creates by one member of nothing both pass).
Creating a SECOND org, invites and member management belong with Organisation settings
(ADR-0059), not here.

## The page's name as the breadcrumb's last segment, everywhere (raised 2026-09-18)

The trace page's header ends its trail with the page's own name — `demo / issue-triage /
traces / tr_01M2…`, not a link, styled as the title — instead of a trail plus a separate title
row (M4 plan, Deviation 75). It saves a row and reads "where you are" as the end of the path.
Every other page still uses a trail above a title (`demo / issue-triage` then **Traces**).

**Decide once the trace page has been lived with** (stakeholder: "we won't decide that now").
The switch is one prop on `PageHead` (`titlePlacement="trail"`) per page, so it can move all
at once. Two things to weigh: Home's trail would become a single segment (`demo / Panels`),
and a section's name in the trail loses the title's size as the page's main landmark.

## Panel-scoped access for internal members (raised 2026-09-18, M5)

Membership is org-wide: an admin, engineer or annotator holds their role across **every** panel
in the organisation. That is a real limitation, not a hypothetical one.

**Partly, and accidentally, addressed by assignment (2026-09-21).** M5 phase 7 replaces the
panel-wide queue with assigned annotation sets (ADR-0079), so an annotator now reaches only the
sets given to them — the sentence above used to end "and M5's annotator will see every panel's
review queue", which stopped being true. **Assignment is therefore the only thing narrowing an
annotator to a panel**, confirmed as the deferral arriving early rather than an accident, and
assigning somebody a set GRANTS read access to those traces in a panel they can otherwise reach
nothing of.

**It does not close this item.** Assignment is a positive grant with no negative: nothing stops
one person being assigned sets from two competing brands' panels, and there is still no way to
say "this person may NEVER see Brand B". An agency's requirement is the second kind. The design
below is unchanged. An **agency serving clients with competing brands** runs
each client as a panel in one org, and must be able to keep a member to the panels they work on
— a person annotating Brand A's traces must not see Brand B's.

**Design it once, with M8's guest-expert access**, which already needs panel scoping
(PRODUCT.md §5.1, ADR-0072) — two mechanisms for "which panels may this person reach" would
drift. Shape to start from: a member × panel grant (an absent grant meaning every panel, so
today's orgs are unaffected), checked ALONGSIDE the role capability map. It is not an extension
of `createAccessControl` (ADR-0068), which answers "may this role create annotations" with no
notion of which panel. Every panel-scoped read — the panel list, traces, keys, the review queue —
filters by it, and `org_invitations` gains the panels an invitation grants.

**Promote earlier than M8 if** a real customer arrives with competing clients in one org.

## Bulk seed upload — the on-ramp to a gate (raised 2026-09-19)

Today a new panel waits for 50 LIVE calls before annotation opens. A team with an agent already
in production has months of runs in its own database, and could start annotating the same day.

**Shape:** a batch endpoint on a panel taking past traces in ADR-0073's four roles
(`input`/`output`/`reference`/`metadata`), each with its **original timestamp** (an ingest time
would make a backfill look like it all happened today) and the caller's **own id** (so a re-upload
is idempotent). Stored exactly as collecting-mode traces are, and counted toward the 50-trace gate.
**It never calls a model** — cheap, fast, and no cost question to answer.

**What it is NOT:** a way to judge history. "Run judges on 30% of the upload" is backtesting — a
deliberate pre-launch step with judge alignment (M6/M7), not a side effect of uploading. Keeping the
two apart is the line between an on-ramp to a gate and an experiments platform (Braintrust and
Langfuse's ground). The test for every feature here: *does it get a team to a working gate sooner?*

**Depends on** ADR-0073 (the four roles), still Proposed. **Promote** with M6, when judges are
first authored from annotations and a seeded panel pays off immediately.

## A neutral step format for agentic callers (raised 2026-09-19, ADR-0073)

The shaped view and the judge prompt recognise tool calls in exactly two formats — OpenAI
(`tool_calls` on an assistant message, `role: "tool"` results) and Anthropic (`tool_use` /
`tool_result` blocks) — because those are what agents hold today. An agent sending its
FRAMEWORK's own state instead (a LangGraph state object, a custom step list) is accepted,
stored and judged identically, and reads as labelled fields and JSON rather than as steps.

**The proposal:** recognise a third, neutral shape — an array like
`[{"step": "lookup_account", "args": {…}, "result": {…}}]` — documented as what to send when
you hold neither API's format. It is one branch in `apps/web/src/components/shaped/to-steps.ts`
and one in `apps/api/src/llm/render-for-model.ts`, both of which already return null for an
unrecognised shape and fall back to JSON.

**Parked, not rejected** (stakeholder, 2026-09-19), for the same reason the 64 KiB cap stays at
64: no caller has hit it. Inventing a step vocabulary before an integration needs one is
guessing at a shape. **Promote** when a real agentic integration sends steps we cannot draw —
or before the public writeup, if the agentic story is what the writeup leads with, since a
framework-native trace rendering as raw JSON is the screenshot nobody wants.

## Verification debt

- **The collector-down test.** M3's plan lists "stop the collector; confirm the API keeps
  serving and warns rather than erroring" as a manual verification and it was never run
  against the whole stack. The behaviour has unit coverage — `apps/api/src/otel.test.ts`
  asserts that an export failure reaches the logger at `warn` through the global error
  handler, which is the bridge that made "no traces in Grafana" distinguishable from "no
  traffic" — but the composed version, where the collector is genuinely stopped and the API
  keeps taking requests, has not been exercised. It is a ten-minute check, and it is the
  kind that finds the thing a unit test's fake cannot: a slow collector rather than an
  absent one, and whatever the metrics reader does that the span processor does not.
  Recorded here rather than dropped, per `thoughts/shared/plans/complete/2026-09-08_m3-observability.md`.
