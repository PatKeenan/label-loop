---
date: 2026-08-23T00:30:00Z
author: claude-code
status: open-questions
milestone: M0 (what it blocks) · M5–M8 (what it describes)
topic: cross-thread-reconciliation
related_adrs: [0001, 0003, 0019]
---

# Cross-thread reconciliation — a parallel planning session, checked against this repo

## Why this doc exists

The stakeholder ran an extended planning session in a separate chat and brought back a
capture document dated 2026-08-23 for cross-checking. This doc records the analysis: what
was already true here, what genuinely conflicts, what is new, and the decisions taken while
reading it.

**The other document's own header warning is stale.** It says "repo bundle v7 predates the
panel model: docs still say single judge, LabelLoop, adapter download, classifier-centric
naming — reconcile on return." That reconciliation happened here on 2026-08-22
([ADR-0019](../../../docs/adr/0019-panel-of-judges.md)): the rename is complete, ADRs run
to 0019 rather than 0009, and adapter download is already flagged as a blocking decision on
M7. The panel model itself originated in the other thread and arrived here first; this repo
then elaborated it.

**Nothing in the source document has been applied to a source-of-truth file by this
analysis alone.** Where a decision was taken in conversation it is marked DECIDED below.

---

## 1. Already true here — no action

The architectural theses match what is in the repo and need no reconciliation: gateway
architecture and 100% server-side trace capture (ADR-0001); stateless context-complete
requests with the caller owning context assembly (ADR-0019); serve the step, never the
flow; SDK descoped permanently (ADR-0002); the full stack register including the
no-Redis-until-k6 discipline (ADR-0006); the conventions layer — closed error taxonomy,
one central handler, exhaustive frontend error map, envelope and prefixed ULIDs, zero pino
transports, ports and adapters with `createApp(deps)`, config validated at boot, graceful
shutdown as a tested feature, append-only audit via DB grants; and the thoughts/ workflow
harness with its slash commands.

Per-panel API keys with **individual rate limits and usage meters** (ADR-0003) already
support the B2B case described in §4 below — that mechanism did not need inventing.

---

## 2. Conflicts

### 2.1 Response contract — the urgent one
The source document specifies a locked response shape that differs from what this repo
merged on 2026-08-22, and several of its differences are **improvements**:

| Source doc | This repo | Assessment |
|---|---|---|
| `reasons[]` — taxonomy codes, plus a one-line human `rationale` | `reasoning` free text only | **Theirs is materially better.** Codes are what make the propose→judge→revise loop *directed*; prose cannot be branched on by an agent. The failure taxonomy becomes the remediation vocabulary. |
| `confidence` per judge | *absent* | **A regression this repo introduced.** See 2.2. |
| `judges` keyed by judge slug (object) | `verdicts[]` (array) | Theirs reads better at the call site; ours preserves order and tolerates duplicates. Pick one before M1. |
| `served_by` — `frontier:sonnet` / `finetune:xyz-v3` | absent | Cheap, and puts the graduation story in every payload. |
| `latency_ms`, `attempts` per judge | absent | `attempts` surfaces retry flakiness; `latency_ms` shows which judge shapes p99. |
| `status: ok \| errored \| skipped_sampling \| skipped_short_circuit` | `evaluated \| skipped \| failed \| error` | **Union of both.** Theirs distinguishes *why* a judge was skipped; ours distinguishes `failed` (call completed, answer unusable) from `error` (call never completed). Both distinctions are load-bearing. |
| `aggregation { policy, panel_version }` echoed in the response | `threshold` only | Ours is a subset — see 2.3. |

**Window:** the panel contract is in an open PR as a breaking change. Folding these in
before it merges costs nothing; afterwards it is a second breaking change.

### 2.2 `confidence` was dropped, and the product still promises it
Not a disagreement with the other thread — a **self-inflicted inconsistency**. The
classifier→panel rename removed `confidence` from the response, but `PRODUCT.md` §5.5 and
`BUILD_SPINE.md` M5 both still list **low-confidence sampling** as an annotation queue
strategy. You cannot sample by a confidence you do not return. Either restore the field or
remove the promise; restoring is clearly right, since low-confidence sampling is one of
the better ways to spend an SME's attention.

### 2.3 Aggregation policy — ours is a strict subset
Source: unanimous / quorum(n) / weighted vote / veto judges, versioned, with optional
short-circuit (`early_exit`) and a `skipped_short_circuit` status. Here: weighted score
plus threshold, plus `required` — which is precisely their "veto." **This lands in P3's
`panel_versions` schema**, so the policy set is worth settling before the migration is
written rather than after.

Short-circuit has a real trade-off their doc names honestly: returning as soon as the
verdict is determined loses the sampling data from judges that never ran. Per-panel
choice, not a default.

### 2.4 Product name: "Panel" vs "LabelLoop" — RESOLVED
The source document calls the **product** Panel. This repo is LabelLoop throughout —
`labelloop`, `@labelloop/contracts`, `@labelloop/api`, and 14 doc mentions.

The collision was worse than a rename: **`panel` is the entity name here** (ADR-0019).
"A panel in Panel," "your Panel panels," and an ambiguous `pnl_` all follow.

**DECIDED 2026-08-23: `panel` stays the entity; the product is not called Panel.**
The stakeholder's reasoning is that Panel is too broad as a product name, and the entity
name is the one carrying real weight — it appears in ids, tables, the public path and the
response body, and it is the word a developer types. LabelLoop remains the working title.
No rename follows; this conflict is closed.

### 2.5 Adapter export — the source document resolves an open gate
This repo flagged the contradiction on 2026-08-22 (PRODUCT promises adapter download while
the business model depends on exclusive hosting) and put **blocking decision gates on M7
and M8** so it could not be skipped. The source document decides it: **the platform hosts,
serves and owns the serving layer; tenants own data, taxonomy and alignment history; weight
export is a premium tier.** That closes the gate and is the ADR-0003 amendment both
documents independently call for.

---

## 3. Decisions taken while reading (2026-08-23)

- **Cross-org grants → PINNED, not rejected.** Consuming orgs seeing subscribed external
  panels in their own tool list is parked. The use case is real (a marketing agency with
  its own panels also wanting to consume someone else's), so this is a "not yet" with the
  case recorded, not a "no."
- **Panel ownership and external subscription stays**, including selling to a party who is
  not otherwise on the platform. Crucially this **does not depend on cross-org grants** —
  see §4.
- **API key management is bigger than scopes.** Not just an `evaluate`/`read`/`manage`
  triple bolted onto ADR-0003, but a real roles-and-key-management system: who may issue,
  who may revoke, what each key may do, per-panel gating. It interacts with M4's role work
  rather than sitting beside it.

---

## 4. The B2B beachhead, and why it is cheaper than it looks

An org aligns a panel with its own experts, then sells access to external clients. The
canonical example from the source document: a pharma advertising agency aligns an MLR
(medical-legal-regulatory) pre-check panel with its regulatory staff and sells access to
its clients' in-house teams — inserting its judgment into the client's process without
doing the deliverable. "Serve the step, not the flow," at the business level.

**Strategically this beats the individual-expert marketplace on cold start**, because every
selling org brings its own buyers. Existing client relationships are the liquidity that a
two-sided marketplace normally has to manufacture. The source document argues org-to-org is
therefore the marketplace beachhead and individual experts follow, and that is persuasive.

**It also resolves a fork this repo posed badly.** The 2026-08-22 doc asked whether the
near-term target was a *shared workspace* or a *marketplace*. Org-to-org is a third answer
that is neither: it inherits the workspace data model and skips the marketplace's
cold-start problem.

### The consumer does not need to be a tenant
The single most useful simplification. An external client needs **no org, no login, no
cross-org identity** — they need a key, a meter, and an invoice. Two clients on the same
panel get two keys with independent activity, quotas and revocation, which ADR-0003's
per-key metering already provides.

This is why the beachhead can ship before any marketplace machinery, and it is the
strongest argument for pinning cross-org grants (§3) rather than building them.

### What is genuinely missing
1. **Keys have no name.** The schema is hash + last-4 + status. Telling "Client A's key"
   from "Client B's key" is impossible, which breaks key management the moment there is
   more than one — B2B or not. **A `name` column belongs in P3.**
2. **No subscriber concept.** A key exists; nothing records who holds it or what they
   agreed to pay. Needs a `panel_subscriptions`-shaped table, but that depends on the
   billing model and belongs with M8 rather than being guessed at now.
3. **Billing points the wrong way.** Metering currently rolls up to the org that owns the
   key, who is invoiced. Here the panel *owner* sells, the *consumer* pays, the platform
   takes a rev-share, and SME royalties flow out of the owner's revenue — so the
   contribution ledger gains an **org layer** on the same attribution machinery.
4. **Trace visibility on cross-org traffic** is an unsolved tension the source document
   names honestly: the panel owner needs samples to realign, but the consumer's inputs may
   be confidential (pre-launch campaign drafts). Per-subscription policy — full /
   consented-samples / aggregate-only / masked. Likely the same mechanism as the PII
   masking already promised to guest experts, not a second one.
5. **Paying external consumers are an extraction surface**, which makes anti-distillation
   (§5) not indefinitely parkable.

### Billing is two-sided, and the dashboard has to be
**DECIDED 2026-08-23.** An org that sells panel access both consumes and earns, so the
financial surface has three flows rather than one: **outgoing to us** (judge inference,
subscription), **incoming** (what external consumers pay for this org's panels, net of
platform rev-share), and **outgoing to people** (contribution-ledger payouts to the org's
own SMEs). One org-wide screen across all panels — token usage, spend, revenue, payouts —
then drill down **org → panel → judge → key**.

Judge-level granularity is not decoration: each judge has its own model and graduates
independently, so cost moves per judge, not per panel. Key-level granularity is what makes
two external clients on one panel two separate bills.

**Concrete P3 consequence.** Metering must be attributable at that granularity from the
first migration, because an aggregate cannot be decomposed after the fact. The `traces`
table as planned carried `tr_`, `request_id` and a judge-version FK — but **not the key
that authorised the call**. Without it, "what does Client A owe for this panel" is
unanswerable and so is the org's revenue split. Added to P3.

### The day-one rule this touches
CLAUDE.md requires every annotation-related schema to carry `annotator_id` and immutable
dataset-version links **from day one, because the contribution ledger depends on it**. If
payouts now route org → SME rather than platform → SME, the same day-one argument extends
to org attribution.

---

## 5. New material, and where it belongs

None of this contradicts anything built. Grouped by destination:

**Positioning theses → PRODUCT framing.** Gates-for-mandatory vs tools-for-discretionary
(guardrails must not be model-skippable). Propose → judge → revise, where taxonomy-coded
reasons make agent retries directed rather than random, with loop budgets and stalemate
escalation that feeds the annotation queue — loop failure feeding the flywheel. Goodhart
defense: agents optimising against judges is drift, and judge-vs-human agreement is the
tripwire. And the closing thesis, **"knowledge moves from prompt-time to review-time"** —
stop stuffing SME knowledge into agent prompts, put standards behind a judge; supported by
verification asymmetry, centralised versioned policy versus prompt-rot, and per-verdict
economics instead of per-input-token forever. That is the strongest strategic framing in
the document.

**Distribution → post-M8 roadmap.** One platform-level remote MCP server with dynamic
per-user tool lists, each accessible panel auto-described from its label set — not
per-panel servers. An API surface split with a dashboard-first promotion rule: read-only
analytics ships as MCP tools, audit is an M8 compliance export, management CRUD stays
parked until enterprise pull. And **panel-as-sensor alerting** (§6).

**Fine-tune economics → corrects claims currently in this repo.** One LoRA adapter per
judge, rejecting a multi-task combined model because vLLM multi-LoRA makes serving cost
identical while per-judge preserves independent graduation, isolated retrain blast radius,
and clean payout attribution. A **traffic-volume threshold in graduation eligibility** —
low-volume judges should never graduate. Utilisation arbitrage as the actual business, and
an honest **2–4x versus right-sized frontier** rather than 10–30x, with the marketing claim
softened accordingly. Isolation boundaries: shared frozen base model, all tenant-derived
artifacts org-scoped, authz enforced at adapter load. Serving tiers: shared → pinned →
dedicated.

**Marketplace → V2/V3.** Expert bios backed by platform-generated provenance (alignment
sessions run, agreement scores, staleness upkeep) — self-authored bio as cover letter,
platform metrics as transcript. Cohorts as the human mirror of a panel. The GitHub
work-graph analogy: panel versions as releases, alignment history as commit log, "git blame
for judgment," with deliberate breaks — weight by quality not volume, and contributions pay.

**Competitive map → sales narrative.** Observability tools complement rather than compete
(they sit beside the path, we sit in it). Microsoft Foundry overlaps at the infrastructure
layer only and is a potential partner. The independence / stability / ownership narrative:
judgment living outside the system it judges gives segregation of duties by architecture,
judges that survive model migrations ("your ruler shouldn't be rubber"), and versioned
org-owned judgment data.

---

## 6. Panel-as-sensor alerting

Per-panel, developer-configured, versioned alert rules: sliding-window fail rates ("40% of
the last 25 failed"), **taxonomy-code spikes** which are diagnostic rather than merely
alarming, per-judge latency/error/attempts thresholds, volume anomalies, and
platform-native drift and staleness alerts that nag orgs into alignment sessions. Delivery
by signed webhook (HMAC, retries with backoff, dead-letter), Slack as the first formatter.
V1 guard: counts and thresholds only.

Two observations:

- **The webhook machinery is M2's resilience work pointed outbound.** Signing, retry with
  backoff, dead-lettering — the same patterns being built inbound, which makes this an
  extension rather than new machinery.
- **The alert-to-annotation loop is the clever part.** Events carry `trace_id`s and an
  alert one-clicks the offending traces into an SME annotation queue, so an incident
  becomes data collection and the flywheel closes from the failure side.

---

## 7. Anti-distillation

Defense-in-depth: per-call pricing makes extraction cost money, a ToS no-training clause,
rate and quota limits, and anomaly detection over the verdict stream (volume spikes,
coverage-sweeping or boundary-probing input distributions, near-duplicate perturbations)
→ alert → suspend key.

The honest limit is stated in the source document and worth preserving: determined
distributed extractors are hard to stop, and **the undistillable moat is continuous
alignment.** A clone is a frozen snapshot that goes stale — no realignment loop, no drift
tracking, no named experts. Staleness is the moat, which is an argument for making
alignment recency *visible*, and that is product work already begun in PRODUCT 5.7a.

Correctly parked while panels are private. It stops being parkable when external paying
consumers exist (§4).

---

## 8. The verdict-event stream — an assumption two features share

**Anti-distillation** (§7) and **alerting** (§6) are both described as consumers of "the
existing verdict-event stream," and the source document notes one stream should feed
alerts, the live dashboard and audit exports. This repo has no such stream — it has a
`traces` table. Whether those are the same thing is an architecture question worth
answering **once**, before two features assume it independently.

---

## 9. What blocks imminent work

| # | Item | Blocks |
|---|---|---|
| 1 | Response contract changes (§2.1, §2.2) | The open panel PR — a closing window |
| 2 | Aggregation policy set (§2.3) | **P3** `panel_versions` schema |
| 3 | `api_keys.name` column (§4) | **P3** |
| 4 | ~~Product name (§2.4)~~ | **Resolved** — `panel` stays the entity, the product is not called Panel |

Everything else is M5 or later.
