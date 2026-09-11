---
date: 2026-09-11T00:00:00Z
author: claude-code
status: draft
milestone: M4
topic: m4-console-auth
related_adrs: [0002, 0003, 0005, 0008, 0009, 0014, 0016, 0019, 0020, 0021, 0022, 0023, 0025, 0026, 0034, 0035]
---

# M4 — console, auth, and the interviewer flow

## Problem summary
M4 turns a seeded database into a product a person can drive: OIDC login, roles enforced
server-side, and the console screens that create a panel and its judges, issue and revoke
keys, and read the trace table. Every one of those objects exists in the schema already and
**not one of them has a write path in application code** — panels, judges, judge versions and
API keys are created today only by `scripts/seed.ts` raw SQL, which is precisely what the
milestone's demo moment ("no seeding scripts") removes. The one genuinely new subsystem is the
capability-gated model picker deferred here from M1 by ADR-0021: no catalogue client exists
anywhere in the repo, and the gate that matters cannot be read from the catalogue anyway.

## Relevant files and why each matters

### Auth, as it stands
- `apps/api/src/auth.ts` — better-auth configured with **`emailAndPassword` only, no social/OIDC**; its own header comment names the provider question as "an explicit M4 decision".
- `apps/api/src/middleware/session.ts` — resolves identity *and* org membership; sets `role` on the session and says in prose it is "ENFORCED from M4". Nothing reads it yet.
- `apps/api/src/routes/internal/index.ts` — CORS → better-auth handler (unguarded) → `sessionAuth()` → routes. Registration order is load-bearing; every route added after the guard is protected by construction. This is where a role guard belongs.
- `apps/api/src/repositories/org-members.ts` — `findMembership` deliberately returns the *first* org; the schema is multi-org (ADR-0014) and the narrowing is in the read, not the schema.
- `apps/api/src/config.ts` — no OIDC client id/secret exists; `BETTER_AUTH_SECRET` is defaulted for a zero-secret clone and rejected in production via `superRefine`. `OPENROUTER_API_KEY` is the template for "optional locally, required in production".
- `apps/web/src/routes/login.tsx` — real credential sign-in; its comments name two M4 jobs: real redirect-after-401 (becomes a `beforeLoad` once the query client is in router context) and the design.
- `apps/api/src/middleware/api-key-auth.ts` — the mirror path: bearer token only, never a cookie. The two-paths-never-cross property is already asserted in tests; M4 must not weaken it.

### What M4 must learn to write
- `packages/db/src/schema/{panels,panel-versions,judges,judge-versions,panel-version-judges}.ts` — the object graph the wizard writes: `pnl_` → `pnv_` → join → `jdv_` → `jud_`.
- `packages/db/migrations/0005_immutable_versions.sql` — **`UPDATE` and `DELETE` are REVOKED from the app role on `panel_versions` and `judge_versions`.** Immutability is a Postgres grant, not a convention. Activation stays possible only because the live pointer is `panels.current_version_id` (migration 0004), a column that kept `UPDATE`.
- `apps/api/src/repositories/panels.ts` — read-only (`findLivePanel`, live = the pointer, never `max(version)`). M4 adds the write half beside it.
- `apps/api/src/repositories/api-keys.ts` — read-only lookup by SHA-256 hash. Issuance and revocation do not exist in app code.
- `packages/db/src/schema/api-keys.ts` — `org_id`, `panel_id`, `name`, `hash`, `last4`, `status`, `revoked_at`, `created_by`. **No `scopes` column** (see open question 3).
- `packages/db/src/schema/audit-events.ts` — append-only, grant-enforced, tested… and **written by nothing**. Its own comment says events "arrive with the features that generate them, starting with key issuance at M1" — M1 issued keys from the seed, so the table is still empty. M4 is the first milestone that can honestly write `api_key.issued`, `api_key.revoked`, `panel_version.created`.
- `scripts/seed.ts` / `scripts/seed-judges.ts` — the current creation path, and the reference for how a `jdv_` is legally assembled (pin → `validatePin` → insert). The seed stays; M4 makes it optional rather than load-bearing.

### The model picker
- `packages/contracts/src/model-pin.ts` — `modelPinSchema` (capabilities, `data_collection: 'deny'`, optional `quantizations`, `reasoning.effort` from a **seven-value** ascending enum), `modelPinValidationSchema`, and `modelRefOf`/`parseModelRef` for `<route>:<native-id>`. Its own doc comment says it "becomes an API surface at M4's judge picker".
- `apps/api/src/llm/validate-pin.ts` — ADR-0026's ordinary `evaluate()` probe. Returns `{ok:false, reason}` rather than throwing, explicitly so "M4's wizard renders `reason` beside the field". The `REASONS` map is already written in picker language.
- `apps/api/src/llm/openrouter-provider.ts` — `providerRouting()` translates the pin to `require_parameters`/`data_collection`/`quantizations`; `availableEndpoints` is read from `openrouter_metadata`. **No models/endpoints catalogue call exists** — the only outbound request is chat completions.
- `apps/api/src/architecture.test.ts` — machine-enforced (ADR-0016): no provider hostname, SDK import, or outbound `fetch` outside `src/llm/`. A catalogue client must live inside `src/llm/` or the build fails.
- `thoughts/shared/research/2026-08-30_model-tier-measurements.md` — the measured evidence to build the picker against; read it rather than re-deriving. Its "What M4 should take from this" list is effectively the picker's acceptance criteria.

### Console surface
- `apps/web/src/router.tsx`, `api/client.ts`, `api/queries.ts`, `errors/error-map.ts` — two routes, `hc<AppType>` inference (no codegen), an exhaustive error-code switch that **fails the frontend typecheck when a backend code is added**. Adding console routes means extending this tree, not replacing it.
- `apps/web/nginx.conf` + ADR-0020 — the console container serves static files only and is deliberately not a reverse proxy, so real cross-origin CORS and the real session cookie stay under test.
- `mockups/tokens.css` + `mockups/BRIEF.md` — the approved style guide, retained; `panel-create.html` is listed there as a P1 load-bearing screen, which is M4's wizard (see open question 1).

## Existing patterns and constraints that apply

**The two auth paths never cross, and that is already proven.** CONVENTIONS "Keys & auth":
web sessions and API keys are separate paths, API keys never grant console access, and roles
are enforced in the API layer, never only in the UI. `session.ts` and `api-key-auth.ts` are
the two halves and each is asserted to ignore the other's credential. M4 adds role checks
*inside* the session path; it must not add a cross-path shortcut.

**`/internal` is not `/v1`, and management is not public.** `routes/internal/index.ts`
explains why: `/v1` is a versioned public contract with an OpenAPI document; `/internal` is
consumed by one client in the same repo, typed by Hono RPC inference. The parking lot's
"API surface split" entry parks **management CRUD until enterprise pull**, with a
dashboard-first promotion rule. So M4's panel/judge/key management is internal console RPC,
and PRODUCT 5.2's "management API" is not what ships here. This is what keeps PRODUCT 5.1's
key-scopes gap from being a blocker — it says scopes are needed "before the management API
ships" — but see open question 3, because the column is a different question from the API.

**Immutability is enforced by grant, so the wizard's shape is constrained, not chosen.**
A "save draft, edit, publish" flow over `panel_versions`/`judge_versions` is unrepresentable:
the app role cannot `UPDATE` those rows. Either the draft lives client-side until a single
create transaction, or it lives in a new mutable table. ADR-0003 + migration 0005 make the
first the default and the second an ADR.

**Creation-time pin validation is the gate, not catalogue metadata** (ADR-0022, ADR-0026,
and measured). `claude-haiku-4.5` advertises `structured_outputs`, is sent `maxLength: 280`
under `strict: true`, and returned ~570 characters on 4 of 4 attempts. `supported_parameters`
is a **union across endpoints** — `claude-sonnet-5` had 9 endpoints, 3 of which could not do
structured output at all. So the catalogue can only ever *populate* the picker; `validatePin`
is what *gates* it, and `available_endpoints` (5 of 9; 1 of 5 for `gpt-5.6-sol`) is the
failover number only that call can produce. ADR-0026 is explicit: "M4's judge wizard is where
an unsatisfiable pin becomes a literal form error."

**Two constraints the picker cannot gate on.** `data_collection: 'deny'` is not queryable —
no data-policy field exists on the endpoints or providers API (ADR-0023) — so its effect on
pool size is knowable only by asking. And `reasoning.mandatory` must not be rendered as
"this model always reasons": `gemini-3.5-flash-lite` is `mandatory: true` and reported **0
reasoning tokens** at `minimal` across three runs, so that warning would be false for the
cheapest, fastest model measured.

**Every judge is two-valued and carries a weight** (ADR-0034, ADR-0035). The wizard must
collect polarity (`passes`/`fails`), a weight `> 0` (CHECK, not nullable), `required`, and the
panel threshold. It cannot offer "no polarity" or a zero weight, and the DB will refuse both.
One judge per failure category, never a bundled multi-criteria question (ADR-0019).

**Error codes are a closed enum with an exhaustive frontend map.** Any new failure the
console can produce is either an existing code or a contracts PR that will not typecheck until
`error-map.ts` decides what the user sees. An unsatisfiable pin is *not* an error — it is an
ordinary `{ok:false, reason}` answer rendered beside a form field.

**Ids, envelope, timestamps, `created_by`.** Prefixed ULIDs; `{data, request_id}` on every
response; `created_by` references `user` with `ON DELETE RESTRICT` because the contribution
ledger keys on a person, not a membership (PRODUCT 10).

**Branching and CI.** One branch + PR per plan phase, PR title is the squashed conventional
commit, description names M4. `bun audit --audit-level=high` runs in CI, so an unrelated
advisory can fail an M4 PR.

## What M4 unblocks elsewhere
- **`docs/BREAKING_POINT.md` v0 reports a limiter bound, not a saturation point.** §6 names
  "more than one API key" as "the single largest gap, and the direct cause of the headline" —
  one key at 60/min cannot exceed ~1 served request/second — and §8 ranks "mint many keys"
  first among what would make v1 worth reading. M4's key issuance is the enabler. Worth
  planning the *shape*: a k6 script that mints N keys needs a programmatic path, and the
  console-only decision above means that path is either the internal RPC with a session, or a
  seed/ops script. Naming which one is an M4 plan decision, not a v1 BREAKING_POINT decision.
- **`docs/PARKING_LOT.md` "Verification debt"** — M3's collector-down test against the whole
  stack, ten minutes, still unrun. Not an M4 dependency; a cheap thing to carry.

## Decisions taken — stakeholder, 2026-09-11
Answers to the seven questions below, recorded here so planning reads decisions rather than
questions. Each one that is a stack row or an architectural commitment needs an ADR; the next
free number is **0046**.

1. **Phase A resumes for `panel-create.html` ALONE.** The other two load-bearing screens stay
   paused until M5/M6, and the six harvest blockers stay open — none of them gate this screen.
2. **A component library is adopted: shadcn/ui — new STACK_DECISIONS row D17, and an ADR.**
   The stakeholder's condition resolves the one-aesthetic-decision-point objection rather than
   overriding it: **`tokens.css` is CONVERTED into shadcn's own theming convention** so there
   is still one token source, expressed the way the library expects, and reusable. Tailwind
   enters as a consequence. Two conversion constraints, recorded because they are where the
   approved palette could silently be lost:
   - **Our vocabulary is richer than shadcn's.** `--color-line-soft`/`--color-line`/
     `--color-line-strong` collapse to shadcn's single `--border`, and shadcn has no
     equivalent of the `data-density` axis at all. Keep `tokens.css`'s full vocabulary as the
     source and define shadcn's required names as ALIASES onto ours — never flatten ours to fit.
   - **Selector convention differs.** shadcn keys dark off a `.dark` class; ours is three
     attribute axes (`data-tone`, `data-surface`, `data-density`). Tailwind v4's
     `@custom-variant` covers it, but it is deliberate setup, not a default.
   The mockup itself stays plain HTML + CSS — CLAUDE.md's hard rule governs `mockups/`, and
   Phase C rebuilds clean, so the library lives only in `apps/web`.
3. **OIDC provider: GitHub, and only GitHub.** Credential sign-in is **kept locally and
   DISABLED in production** (`emailAndPassword: { enabled: NODE_ENV !== 'production' }`), so the
   fresh clone still boots and signs in with no secrets (ADR-0009) while production has exactly
   one door. `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` follow the `OPENROUTER_API_KEY` pattern:
   optional locally, `superRefine`-required in production.
   - **Consequence to design for, not discover at M8:** a first-time GitHub sign-in in
     production hits `FORBIDDEN` / "not a member of any organisation", because there is no
     invite flow at M4 and the seed user is a password account. How the first admin gets an
     `org_members` row in production (seed by GitHub email, an ops script, or
     first-user-becomes-admin) is an M8 deploy concern, named here so it is a decision.
4. **`api_keys` gets NO `scopes` column at M4** — deferred to when the management API ships,
   which is what PRODUCT 5.1 literally asks and which the parking lot parks until enterprise
   pull. **Accepted cost, stated rather than implied:** every key issued between now and then
   needs a backfill when scopes arrive, and M4 is the milestone that starts minting them in
   volume. The plan proceeds on the assumption that keys are implicitly `evaluate`-only.
5. **M4 writes the first `audit_events` rows**: `api_key.issued`, `api_key.revoked`,
   `panel_version.created`, `judge_version.created` — `actor_type='user'`, `actor_id` from the
   session, `request_id` bound (ADR-0010). M8 still owns the viewer, retention and export. This
   is the first time the append-only grant is exercised by application code rather than a test.
6. **The org-switcher seam SHIPS at M4.** The org stops being implicit, which is a real scope
   addition and changes the shape of the auth phase:
   - `findMembership` becomes a list, and the request must say which org it means — so every
     internal route validates the requested org against membership. This is exactly the leak
     `session.ts` warns about ("authenticates and then forgets to filter"), so the negative
     tests (another org's id must not leak) belong in the same phase.
   - **Role resolves per SELECTED org**, not the first — so `requireRole()` and the switcher
     are one phase, not two.
   - **Do not reach for better-auth's organization plugin.** It would contradict ADR-0014,
     which deliberately put `role` on our own `org_members` rather than in the auth library.
7. **Catalogue: live fetch with an in-memory TTL cache**, in `src/llm/` (ADR-0016). A failed
   refresh serves the last good snapshot and warns; a cold start with no network leaves the
   picker unpopulated and the wizard must say so plainly rather than appear empty. No new
   table, no new job.

## Open questions for the human
> **Answered 2026-09-11 — see "Decisions taken" above.** Retained as the reasoning behind
> each call rather than deleted; the provenance is the point (CLAUDE.md).

1. **Does Phase A resume at M4, and if so for exactly one screen?** `mockups/BRIEF.md` says
   the first milestone needing a designed screen is M5, but its own scope list names
   `panel-create.html` (P1) — "the interviewer's entry point" — which is M4's wizard, and
   BUILD_SPINE's standing rule counts it among the three load-bearing screens. **None of the
   six blocking product decisions in the harvest gate it**: five are annotation/eval concerns
   (consensus scoring, confidence withholding, the annotation-round object, judge-validation
   metrics, the arbiter role) and only "trace-explorer column count" touches M4 at all. So the
   options are (a) resume Phase A for `panel-create.html` alone, leaving the rest paused,
   (b) ship all of M4 unstyled and keep the pause whole until M5, (c) full resume. My read is
   (a) or (b); the harvest's blockers argue against (c).
2. **Which OIDC provider, and what happens to email+password?** BUILD_SPINE and
   SENIORITY_CHECKLIST 6 both say "OIDC login"; `auth.ts` currently has credential login only
   and states social providers need client secrets that ADR-0009 forbids requiring of a fresh
   clone. The repo already has the pattern for this shape (`OPENROUTER_API_KEY`: optional
   locally, `superRefine`-required in production) — but "which IdP" (GitHub? Google? both?) is
   a stakeholder call, and so is whether credential login survives as the zero-secret demo
   path or is removed in production.
3. **Does `api_keys` get a `scopes` column now, unenforced?** PRODUCT 5.1 requires
   `evaluate`/`read`/`manage` scopes and says ADR-0003 needs an amendment "before the
   management API ships" — which, per the parking lot, is not M4. But M4 is the milestone that
   starts minting keys through a UI (and BREAKING_POINT wants many of them). This repo's own
   precedent is explicit and twice-applied — `org_members.role` and `judge_versions.required`
   both shipped as columns at M0, unenforced, because "a column is cheap today and a backfill
   against live membership is not" (ADR-0014). Same reasoning, same call to make, now.
4. **Should M4 write the first `audit_events` rows?** The table has been append-only,
   grant-enforced and tested since M0 with zero writers, and its comment expected key issuance
   to be the first. M8 owns the *viewer*, retention and export; writing `api_key.issued`,
   `api_key.revoked` and `panel_version.created` costs little here and makes the M8 screen a
   read over real history rather than a demo over backfilled rows. In or out of M4?
5. **Console styling: plain CSS on `tokens.css`, or a component library?** D2 decides the
   framework and says nothing about styling; `apps/web` has no CSS dependency at all today. A
   component library would be a STACK_DECISIONS row and therefore stakeholder-owned. The
   zero-new-row answer is plain CSS consuming the approved tokens — but that only holds if
   question 1 lands on (a) or (b).
6. **PRODUCT §11's last open question is aimed straight at this milestone:** "Is the near-term
   target a shared workspace or the marketplace? … the answer changes what M4/M5 must not
   foreclose." Specifically: does the console assume one org per user (which
   `findMembership` currently does) or ship an org switcher seam?
7. **How does the catalogue get populated, and how fresh must it be?** A live fetch per wizard
   load, a cached snapshot, or a committed list. This is a new outbound call constrained to
   `src/llm/` by ADR-0016, and the honest answer may be "fetch and cache", but the failure mode
   (wizard unusable when the catalogue is unreachable) deserves a decision rather than a
   default.

## Recommended approach (input to planning, not the plan)

Sequence the milestone so each phase is a branch with something verifiable at its end, in
roughly this order:

1. **Roles enforced server-side, WITH the org-switcher seam** (decision 6 merged them). The
   org becomes explicit, `findMembership` becomes a list, every internal route validates the
   requested org against membership, and `requireRole()` resolves the role for the selected
   org. Tests that matter: an annotator refused an admin route, another org's id refused
   rather than leaked, a role change taking effect, and the existing "API key gets nowhere
   near the console" assertion still passing. No longer the smallest phase.
2. **GitHub OIDC**, credential sign-in disabled in production only, keeping the zero-secret
   local boot intact.
3. **Key issuance and revocation** over `/internal`: create (plaintext rendered exactly once,
   SHA-256 stored, `last4` kept), list, revoke as a status flip. No `scopes` column (decision
   4). This is the phase that unblocks BREAKING_POINT, and the first `audit_events` writer
   (decision 5).
4. **The catalogue client and the model picker** — live fetch, in-memory TTL, last-good
   snapshot on refresh failure (decision 7) — inside `src/llm/`, built against the measured
   table rather than against `supported_parameters`: show cost, measured latency *and its
   spread*, endpoint count after the pin, and the effort dial's per-model cost/latency
   consequence. Gate on `validatePin`, surface `reason` verbatim in the form.
5. **The panel + judge wizard**, designed first as `mockups/panel-create.html` (decision 1)
   and then rebuilt clean on shadcn/ui over the converted tokens (decision 2), writing `pnl_`/`pnv_`/`jud_`/`jdv_` in one transaction with
   the pin validated before the insert, and activation via the `panels.current_version_id`
   pointer. The draft is client-side state until submit, because the grants leave no other
   option without an ADR.
6. **Trace table**, extending the existing `/internal/traces` route rather than replacing it.

Two things to carry into planning: the wizard is where an unsatisfiable pin becomes a form
error (ADR-0026 says so by name), and M4's "Not now" list is load-bearing — no annotator UI
polish, no guest experts, no taxonomy tooling, and **no client SDK** (ADR-0002, D5; BUILD_SPINE
and CONVENTIONS were corrected on 2026-09-11 and `packages/sdk` has never existed).
