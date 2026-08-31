# ADR-0033: The prompt template is named, versioned, and frozen onto the judge

**Status:** Accepted · **Date:** 2026-08-31 · **Milestone:** M4
**Amends:** ADR-0003 (what is versioned) · **Complements:** ADR-0032 (the authored prompt)

## Decision

Everything in a judge request that is neither the judge's authored fields nor the caller's
data is a **template**: a named, versioned artifact with slots. `judge_versions` carries a
`template` field naming which one a judge is frozen against.

**What a template owns.** The whole request shape, not only the message layout: the system
message, the arrangement of the authored fields, and the structured-output schema sent as
`response_format` — including `strict`, the property order, and `maxLength`.

**Slots carry the per-call data.** `artifact` and `context` arrive with the caller's HTTP
request and are filled at call time. This is what lets a template be fixed at authoring time
while the request is still assembled per call.

**Templates are pure TypeScript functions, and are never deleted.** A judge frozen against
`v1` compiles through `v1` forever, which is what makes a past request reconstructable
without storing it.

### The version is resolved at creation and then frozen

A new judge is stamped with the current template; every existing judge keeps whatever it was
created with, permanently. Identical mechanism to `model_pin` (ADR-0022): resolve once at
creation, freeze as a literal, never recompute.

### "Current" is derived in code, never configured

`TEMPLATE_VERSIONS` is an `as const` array and the current template is its **last element**,
with the registry keyed by the union that array produces:

```ts
export const TEMPLATE_VERSIONS = ['v1'] as const
export type TemplateVersion = (typeof TEMPLATE_VERSIONS)[number]
const COMPILERS: Record<TemplateVersion, TemplateCompiler> = { v1: compileV1 }
```

Two properties follow, and the second is the reason for this shape rather than an explicit
`CURRENT_TEMPLATE` constant:

- **A declared version with no compiler fails typecheck.** Adding `'v2'` to the array does
  not compile until `compileV2` exists, so a template that is named and unimplemented is
  unrepresentable rather than merely unlikely.
- **The pointer cannot name something that does not exist**, which an explicit constant — or
  an environment variable — can.

**It is a code constant and not configuration, deliberately.** The template functions *are*
code, so the current version does not vary per environment, which is what `config.ts` is for
(ADR-0009). An environment variable could also name a template the build does not have,
freezing a judge against a compiler that is not there — the permanently broken judge
ADR-0026's creation-time validation exists to prevent. `config.ts` already makes this
argument for the migrator credential: *"the API never migrates and never creates roles, so it
should not be able to express those credentials."* The same applies here. And the pointer
must move atomically with the function it points at: as a code constant, one PR adds
`compileV2` and moves the pointer, and the diff documents itself. Tests needing a specific
template inject one through `createApp(deps)`, which is how everything else in this codebase
is substituted.

**Cost accepted: array order becomes load-bearing.** Nothing about an array signals "do not
reorder", so the ordering carries a comment saying so — as `REASONING_EFFORTS` already does
for its ascending order — plus a test asserting the current value. Bumping then costs two
lines rather than one, which is the right friction for a change that alters every judge
created after it. Consequence of last-element-wins: a template is current the moment it
exists, so a version cannot be landed and promoted separately. If staging one ever matters,
`current` becomes explicit; the test is what makes that change safe.

### A template is mutable until the first judge freezes against it

Then immutable, permanently. This is the rule for when an edit forces a new version, and it
is deliberately not "when the change is behavioural".

**That question is unanswerable for a prompt.** In ordinary code a typo in a comment is
provably non-behavioural; in a template every byte is model input, so correcting `obejct` to
`object` re-tokenizes the system message and may change the output. Not likely, but not
knowable in advance by the person making the edit — so a rule resting on that judgment
cannot be applied correctly.

The reference test replaces it with a query: *does any `jdv_` name this template?* Before the
first one, an edit breaks nothing and a new version buys no safety. After it, an edit
silently re-means a frozen judge. This is the same rule ADR-0003 already applies to versions
themselves — immutable **once created**, not from the moment someone starts drafting — and
the same shape as `model_pin`, freely editable until the row is written, which is why
`validatePin` runs at that last moment (ADR-0026).

**Enforced by a golden snapshot per template.** Each template's compiled output for a fixed
input is committed, so any byte change fails CI until the snapshot is deliberately updated.
That does not enforce bumping by itself; it does something more useful — it makes an
accidental template change impossible to merge unnoticed, and puts the question to a reviewer
at the only moment it can be answered: *you changed v1's output; has anything frozen against
v1 yet?* The same reasoning as the architecture tests (ADR-0016) — the rule concerns the shape
of the repository, so a test enforces it and the failure reads as a sentence.

**Version sprawl is accepted, and is smaller than it looks.** Templates are not a changelog;
nobody will diff v12 against v13, and it is fine that two differ by a space. They exist so a
frozen judge reconstructs. The real cost is that the shared contract suite runs against every
template forever — which is the right bill to pay, since it is exactly what guarantees an old
judge's template still fences injection.

### A template is a port, with a shared contract suite

Every template implements one interface, which makes it the same shape as `ModelProvider` and
brings CONVENTIONS' rule with it: *"Base test suites live beside each port: every adapter
(real or fake) must pass the port's shared contract test."*

One suite therefore asserts, for **every** version: the four output keys in contract order
(ADR-0019), that the artifact reaches the request, and that untrusted trace content is
fenced. A new template cannot be added without satisfying them. This is what makes M6's
injection-fencing requirement structurally enforced across templates rather than remembered
once per template — the same reasoning that made `provider.contract-test.ts` worth having.

### Each template declares the prompt fields it consumes

A template carries a Zod schema for the authored fields it requires. `v1` requires
`question`; a later template may require `rubric`. Creating a judge whose `prompt` does not
satisfy its template's schema is therefore a **named error at creation** — the same shape as
`validatePin` answering with a reason rather than throwing (ADR-0026), and caught at the last
moment the judge can still change, before ADR-0003 freezes it.

`TEMPLATE_VERSIONS` feeds `z.enum()` for the stored value, exactly as `REASONING_EFFORTS`
feeds `reasoningEffortSchema`.

### The pointer and the record are different things

Only one of them does the reconstruction work, and conflating them is easy:

- **The "current" pointer** decides what *new* judges get. Consulted once, at creation. It
  plays **no part** in reconstruction.
- **`judge_versions.template`** records what *this* judge uses. This is the entire
  reconstruction mechanism: read the row, look up that function, compile.

So even a wrong pointer could not corrupt an existing judge — the answer lives on the row.

## Context

The scaffold around a judge's question is larger than the question. From a request captured
on 2026-08-31, the judge's own authored contribution was one sentence; the system message,
the `Question:`/`Context:`/`Artifact:` layout, and the entire `response_format` block came
from `apps/api/src/llm/openrouter-provider.ts` — shared byte-identically by every judge in
every tenant, and recorded on no version.

**The consequence is that a `jdv_` does not currently determine its own behaviour.** Two
byte-identical judge versions can answer differently because a string in the adapter moved
between them, and nothing anywhere records that it did. BUILD_SPINE M6 promises *"agreement
by judge version"* and SENIORITY_CHECKLIST §2 promises *"agreement dashboards over time,
pinned to judge versions"*. Both are claims about an identifier that does not currently fix
the thing being measured — the same defect `aggregation { panel_version }` was added to
ADR-0019 to close for panels.

This is not hypothetical. `maxLength: 280` lives in that unversioned block, and on
2026-08-30 it caused `anthropic/claude-sonnet-5` to fail pin validation on 4 of 5 probes
(rationale lengths 274–384 against a 280 cap) while two other models passed 5 of 5. A
judge's behaviour was decided by a constant in our source tree.

**Why a named template rather than a stored rendered request.** The alternative under
consideration was storing the fully rendered request on every verdict — definitive, but
bulky and duplicated per row. Keeping the compiler instead makes reconstruction free: the
template id is a short string, and the function that produced the request is still in the
tree. Storage cost collapses from per-verdict to per-template.

**Why the template owns the output schema too.** Restricting it to message layout would
leave the schema — the half with a measured defect — unversioned, which defeats the purpose.
Owning it also converts the M1/P5 rationale-cap fix from *"edit a constant and silently
change every judge that has ever existed"* into *"`v2` raises the cap; judges stay on `v1`
until someone creates a new version of them."* Same fix, with a version and a blast radius.

**Precedent.** This is the pattern already accepted twice in this repo. `MODEL_ROUTES` is a
small closed vocabulary frozen per row and extended by addition, with `finetune:` documented
as additive at M7. `model_pin` (ADR-0022, ADR-0025) freezes a contract as a concrete literal
precisely so its meaning cannot move when something upstream changes a default. A template id
is that idea applied to the last unversioned input to a judge call — where the upstream that
moves is us.

Rejected alternatives:

- **Leave the scaffold anonymous.** The status quo. Cannot be retrofitted: once judges are
  frozen against an unnamed scaffold, nothing can ever say which one they used.
- **A bare incrementing integer with no registry.** Records *that* something changed without
  making the old behaviour runnable, so reconstruction still requires digging through git.
- **Store the full rendered request on each verdict.** Definitive but duplicated per row, and
  it answers "what was sent" without answering "what would this judge send now".
- **Hold the current version in an environment variable** — see above: it does not vary per
  environment, it can name a template the build lacks, and it decouples the pointer from the
  function it points at.
- **Compile in Postgres** — rejected in ADR-0032: the output schema is not a function of the
  row, and hand-writing it into SQL is the second copy `judge-schema.ts` exists to prevent.
- **Tenant-editable templates.** Out of scope and probably permanently: injection fencing
  lives here, and a tenant-editable scaffold is a tenant-editable security boundary.

## Scope: what M4 ships

At M4 there is exactly one template. Building a registry, a dispatcher and a versioned schema
family for a single entry would be speculative, so M4 ships **the identifier and the shape
that makes it safe** — `TEMPLATE_VERSIONS` with one entry, the typed registry, the shared
contract suite, and `v1`'s input schema — but not a second template.

The split follows the irreversibility: the *identifier* cannot be added later without
orphaning every judge frozen before it, while the second template arrives the day something
forces it, which the rationale-cap fix will. `MODEL_ROUTES` was built this way: two real
entries and a documented slot, not a plugin system.

## Visibility: plumbing until the first migration between templates

- **Hidden from the annotator, always.** They see the question, the artifact, the verdict and
  its reasoning. A template id is noise on the surface that most needs to be uncluttered.
- **Hidden from the author at creation.** Nobody picks a template in M4's wizard; it is
  assigned.
- **Absent from the evaluate response.** `served_by` and `aggregation.panel_version` are
  echoed (ADR-0019) because they vary per call and explain a result; the template does not
  vary and is derivable.
- **Visible in the judge-version detail view**, beside model, pin and prompt. That view's job
  is "what exactly is this frozen thing", and hiding part of the frozen configuration
  undercuts the point of freezing it.
- **Load-bearing in the agreement timeline.** A judge moving `v1`→`v2` puts a discontinuity
  in its agreement history, and M6's dashboard must be able to attribute it — otherwise a
  template change reads as model drift, which is the confusion this ADR exists to prevent.

**The lock state is an engineer-console concern.** Whether a template is still editable or
has been sealed by its first judge is worth showing, and it belongs on the dense surface
beside model, pin and prompt — never on the annotator flow. CLAUDE.md makes this a hard rule:
two distinct surfaces, the annotator flow *(minimal, friendly, non-engineer)* and the engineer
console *(dense, detailed)*, intentionally different experiences. An SME in an alignment
session should be looking at the twelve traces where the judge disagrees with them, not at
whether a template is sealed.

Distinguish it from a judge's own state, which is a different axis. A `jdv_` is **always**
frozen — migration `0005_immutable_versions.sql` `REVOKE`s `UPDATE, DELETE` on it — so a judge
has no unlocked state to show. What varies is whether it is *live*: `panels.current_version_id`
is a pointer rather than "the highest version", which is what makes a draft possible at all,
since otherwise a new version would go live the instant it was inserted. So the engineer
console shows two different things — a template that is *sealed or not*, and a judge version
that is *live or not* — and conflating them would be a mistake.

So it is infrastructure right up until it changes something someone measured, at which point
it is the explanation.

## Consequences

- `packages/contracts` holds one judge output schema per template version. v1's is frozen the
  day v2 exists and is never edited again — the same deal as a past migration.
- Template functions are pure and take no I/O, so they stay unit-testable offline, preserving
  the property ADR-0028 protects for the rest of `llm/`.
- Old templates are permanent. The maintenance tail is real and bounded: a frozen pure
  function whose test never changes again.
- The template id is **not** duplicated onto `trace_verdicts`. Unlike `served_by`, which
  varies per call and cannot be derived, it is reachable through the `judge_version_id` FK
  the verdict already carries. This changes if a template ever becomes selectable per call.
- With `prompt` (ADR-0032) and `template` both on the row, a `jdv_` finally determines its own
  behaviour, and "agreement by judge version" becomes true rather than aspirational.

## Open questions this does not settle

- **Whether a template pins a provider-shaped request or a neutral one.** At M1 there is one
  provider; at M7 a `finetune:` route may need a different envelope for the same template.

Provenance: `thoughts/shared/progress/decisions-log.md` (2026-08-31);
`thoughts/shared/research/2026-08-30_genesis-docs-reconciliation.md`.
