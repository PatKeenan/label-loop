---
date: 2026-09-11T18:40:00Z
author: claude-code
status: approved
approved_at: 2026-09-11T19:02:34Z
approver: Pat Keenan
milestone: M4
topic: m4-console-auth
related_adrs: [0003, 0008, 0009, 0014, 0016, 0019, 0020, 0022, 0023, 0025, 0026, 0034, 0035, 0046]
spawned_adrs: [0047, 0048, 0049, 0050, 0051, 0052, 0053, 0054, 0055, 0056, 0057, 0058]
---

> **STATUS — 2026-09-14. Phases 1–5 are MERGED; next is phase 6.**
>
> | phase | PR | |
> |---|---|---|
> | 1 — tenancy and roles | #58 | merged |
> | 2 — GitHub OIDC | #59 | merged |
> | 3 — keys and the audit log | #60 | merged |
> | 4 — the catalogue | #61 (+ #62, CI) | merged |
> | 5 — panel and judge creation | #63 | merged |
> | **6 — the frame, as mockups** | #65 | **complete · 6a, 6b (r2/r3) and 6c (r3) approved 2026-09-15** |
> | **7 — the frame, built** | #67 | **VERIFIED by the stakeholder 2026-09-16** |
> | 8a — the API half | #69 | merged |
> | **8b — the console half** | — | **PR open; steps below still to finish** |
>
> **How to read the checkboxes in phases 1–5.** `[x]` is verified, and each one says WHO
> verified it — the stakeholder, or Claude during implementation. `[~]` is **deferred and does
> not block the next phase**; each says why. There are no `[ ]` boxes left in phases 1–5, so a
> session resuming from this file should start at phase 6 and not re-open earlier phases.
>
> Phase 6 is mockup work under a PARTIAL Phase A resume (ADR-0055), not application code — see
> CLAUDE.md "Current phase". Open question 3 below applies directly to 6c.
>
> **Phase 7 is VERIFIED (stakeholder, 2026-09-16)**, walked through in the running console
> rather than read: sign-in, Home, the panel switcher, a panel's Overview, the section nav with
> its padlock and milestone marks, the trace table on real data, Keys, and both not-available
> states. That walk-through is where Deviations 53 and 54 came from — four bugs no automated
> check in this phase could have caught. The org switcher's BEHAVIOUR stays `[~]`: verifying it
> needs a second membership no seed creates.
>
> Two stakeholder decisions were taken during the phase and are recorded, not just looked at:
> **Sonner was admitted into D17** (D17 and ADR-0046 amended), and **the URL shape** the flow
> map left to this phase.
>
> **The plan STAYS in `approved/`, because phase 8 is in it and is unbuilt** — 17 unchecked
> steps, and its scope was rewritten by ADR-0060 and ADR-0061 (Deviations 32–41). CLAUDE.md's
> hard rule is that implementation comes only from `approved/`, so filing this under `complete/`
> now would strand the document phase 8 has to be built from.

# M4 — console, auth, and the interviewer flow

## Goal
Turn a seeded database into a product a person can drive. M4 ships GitHub OIDC login,
roles enforced server-side over an explicit org, and the engineer console that creates a
panel and its judges through a wizard producing an immutable version 1, issues and revokes
API keys, and reads the trace table. Its demo moment is the full interviewer flow **with no
seeding scripts** — which is the honest test, because every object involved exists in the
schema today and none has a write path outside `scripts/seed.ts`. The one genuinely new
subsystem is the capability-gated model picker deferred here from M1 by ADR-0021: a model is
offerable only when an endpoint satisfying that judge's pin actually supports structured
output, and the catalogue cannot answer that — only ADR-0026's validating call can.

**Milestone:** M4 in `docs/BUILD_SPINE.md` ("Console + auth + the interviewer flow",
Categories 6 and 1). Every phase below maps to that section's four named deliverables plus
the capability-gated picker it calls out by name.

**Research:** `thoughts/shared/research/2026-09-11_m4-console-auth.md`, including the seven
stakeholder decisions taken 2026-09-11.

**Stack check (create_plan rule 3):** this plan introduces no technology outside
`docs/STACK_DECISIONS.md`. shadcn/ui and Tailwind are **D17**, decided 2026-09-11 and
recorded in ADR-0046. GitHub social login is inside **D9**'s existing scope ("OIDC social
login"). Everything else — React/TanStack (D2), better-auth (D9), Postgres/Drizzle (D3),
OpenRouter (D15) — is already decided.

---

## Phase 1 — Tenancy made explicit, and roles enforced

The org stops being implicit. This phase merges what the research listed as two jobs,
because decision 6 makes them one: a role is per-org, so a role guard that resolves against
"the first org" would be enforcing the wrong row the moment a second membership exists.

**The risk this phase carries** is named in `session.ts` itself: *"the classic way a console
leaks across tenants is a handler that authenticates and then forgets to filter."* Today the
org is the only one a request has, so filtering is automatic. Making it explicit removes
that safety, which is why the negative tests are part of this phase and not a follow-up.

### Changes
- `apps/api/src/repositories/org-members.ts` — `findMembership` → `listMemberships(db, userId)`
  returning every membership, plus `findMembership(db, userId, orgId)` for the validated
  single read. The existing doc comment predicted this ("the day an org picker exists this
  becomes a `where` clause and nothing has to be migrated") — it becomes true here.
- `apps/api/src/middleware/session.ts` — resolve the ACTIVE org: read a requested org from an
  `X-LabelLoop-Org` header (see Decisions), validate it against membership, fall back to the
  first membership when absent. **A non-member org answers `NOT_FOUND`, never `FORBIDDEN`** —
  the response must not confirm that org exists (stakeholder, 2026-09-11). `AuthenticatedSession` gains `memberships` so the console can
  render a switcher without a second round trip.
- `apps/api/src/middleware/require-role.ts` — **new.** `requireRole('admin', 'engineer')`,
  composed AFTER `sessionAuth()`, reading `c.var.session.role` — which is now the role for the
  active org. Throws `FORBIDDEN` with a message that does not enumerate what the caller lacks.
- `apps/api/src/routes/internal/index.ts` — no structural change; the guard stays the thing
  every later route is registered behind.
- `apps/api/src/routes/internal/me.ts` — return `memberships[]` alongside the active org.
- `apps/api/src/middleware/session.test.ts`, `require-role.test.ts` — new/extended.

### Steps
- [x] `listMemberships`, with the ordering rule preserved — **no `findMembership`, see Deviation 1**
- [x] `sessionAuth` resolves and validates the active org; unknown or non-member org is refused
- [x] `requireRole()` middleware, with `FORBIDDEN` and a non-enumerating message
- [x] `GET /internal/me` returns active org, role, and the membership list
- [x] Negative tests: a member of org A asking for org B gets `NOT_FOUND` (never `FORBIDDEN`,
      which would confirm it exists); an annotator hitting an admin-guarded route gets
      `FORBIDDEN`; a request with no header still works
- [x] The existing "an API key gets nowhere near the console" assertion still passes untouched

### Automated verification
- [x] `bun test apps/api/src/middleware/` passes — 47 tests, 6 files
- [x] `bun test apps/api/src/routes/internal/` passes — 9 tests, unchanged
- [x] `bun run typecheck` and `bun run lint` clean (full suite also green: 663 tests, 56 files)

### Manual verification
- [x] Sign in locally; `GET /internal/me` shows the seeded org, `admin`, one membership.
      *By the stakeholder, 2026-09-11*, against a rebuilt container — the response showed the
      seeded org, `admin`, and one entry in `memberships`.
- [x] Hand-craft a request with another org's id in the header, and one with an id that does
      not exist at all; confirm the two responses are INDISTINGUISHABLE.
      *By Claude, 2026-09-11, against a source build* — a real second org was inserted for the
      purpose and removed afterwards; both answered 404 `NOT_FOUND` and were byte-identical with
      `request_id` stripped. The stakeholder's first attempt ran against a STALE container and
      appeared to fail, which is why every later manual step names the rebuild.

---

## Phase 2 — GitHub OIDC, and production loses the password door

### Changes
- `apps/api/src/config.ts` — `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, optional locally,
  required in production by the existing `superRefine` (the `OPENROUTER_API_KEY` pattern,
  verbatim in shape).
- `apps/api/src/auth.ts` — `socialProviders: { github }` registered only when both vars are
  present; `emailAndPassword: { enabled: config.NODE_ENV !== 'production' }`. The header
  comment's "explicit M4 decision" is answered in place and dated.
- `.env.example` — both vars, documented as optional locally (CONVENTIONS "Config": exhaustive).
- `apps/api/src/config.test.ts`, `auth.test.ts` — production rejects missing GitHub creds;
  production disables the credential provider; development enables it.

### Steps
- [x] Config vars + production `superRefine` rule with a message naming the field
- [x] GitHub provider registered conditionally; absent creds leave a working local build
- [x] `emailAndPassword` disabled in production only
- [x] `.env.example` updated
- [x] Tests for all three environment shapes — plus the half-a-pair shape, see Deviation 7

### Automated verification
- [x] `bun test apps/api/src/config.test.ts apps/api/src/auth.test.ts` passes — 34 + 9 tests
- [x] `bun run typecheck` clean (full suite also green: 679 tests, 57 files; `lint` clean)

### Manual verification
> **Against which build?** Phase 1's manual check was first run against a stale
> `labelloop-api:dev` container on port 3000 and appeared to fail. Rebuild before verifying —
> `docker compose -f infra/docker-compose.yml up -d --build api` — or run from source with
> `bun run --cwd apps/api dev`. The tell for a stale build here is a GitHub button that 404s
> with the credentials set.

- [x] A fresh clone with **no** `.env` still boots and signs in with the seeded password
      account (ADR-0009 — this is the property most at risk in this phase).
      *Verified headlessly during implementation:* booted via `env -i` with `DATABASE_URL`
      alone — `/healthz` 200, password sign-in 200, `/internal/me` 200, and
      `sign-in/social` a clean `PROVIDER_NOT_FOUND` rather than an error. *By Claude*; not
      re-run by the stakeholder.
- [x] With a real GitHub OAuth app (localhost callback), the GitHub button completes a
      sign-in and lands on "not a member of any organisation" for a new account — the
      expected M4 behaviour, and the M8 gap named in the research.
      **Needs a registered OAuth app**; the callback is asserted in `auth.test.ts` as
      `http://localhost:3000/internal/auth/callback/github`.
      **The button is a throwaway added by this phase** (Deviation 11) — the plan did not
      schedule one until phase 8, which is later than the check that needs it.
      *By the stakeholder, 2026-09-11* — account created with `provider_id: github`, session
      issued, console refused with FORBIDDEN. Two findings came out of it: compose never passed
      the credentials (Deviation 12), and `FORBIDDEN` means two things in the console (phase 8).

---

## Phase 3 — Keys issued and revoked, and the audit log gets its first writer

This is the phase BREAKING_POINT is waiting on (§6, §8: "mint many keys" is the single
largest gap and the direct cause of its headline being a limiter bound rather than a
saturation point).

### Changes
- `apps/api/src/repositories/audit-events.ts` — **new.** `recordAuditEvent(db, {...})`,
  INSERT only. The first application code to write the table since it shipped at M0.
- `apps/api/src/repositories/api-keys.ts` — add `insertApiKey`, `listApiKeys(orgId)`,
  `revokeApiKey(id, orgId)` (status flip + `revoked_at`, never a delete) beside the existing
  hot-path read.
- `apps/api/src/services/api-keys.ts` — **new.** Mint `llk_test_`/`llk_live_` + 32 random
  bytes, store `sha256Hex` (reusing the helper already in `api-key-auth.ts`), keep `last4`,
  return the plaintext to the caller exactly once, write `api_key.issued`.
- `apps/api/src/routes/internal/keys.ts` — **new.** `POST /internal/keys` (create),
  `GET /internal/keys` (list, org-scoped), `POST /internal/keys/:id/revoke`. Behind
  `requireRole('admin', 'engineer')`.
- `apps/api/src/routes/internal/index.ts` — register the route after the guard.
- `scripts/mint-keys.ts` — **new** (stakeholder, 2026-09-11). Mints N keys through the SAME
  service the console calls, so the load harness needs no session, no CORS and no new API
  surface. This is what `docs/BREAKING_POINT.md` §8 ranks first among what would make v1 worth
  reading: one key at 60/min cannot exceed ~1 served request per second, so the instance's knee
  is currently unreachable rather than unmeasured. Built here because the service is being
  written here; retrofitting the door later is the expensive version.

### Steps
- [x] `recordAuditEvent` with `actor_type='user'`, `actor_id` from session, `request_id` bound
- [x] Key minting: prefix + 32 random bytes, SHA-256 stored, `last4` kept, plaintext returned once
- [x] List and revoke, both org-scoped from the session and never from a request parameter
- [x] Revocation is a status flip; the row survives, and a revoked key still resolves in the
      hot-path read (which is deliberate — see `api-keys.ts`)
- [x] `api_key.issued` and `api_key.revoked` written
- [x] Tests: plaintext appears exactly once and is not in any later response; a revoked key is
      refused at `/v1`; another org's key is neither listed nor revocable
- [x] Test: the audit rows land and the app role still cannot UPDATE or DELETE them — proven
      the hard way, see Deviation 13
- [x] `scripts/mint-keys.ts` mints N keys via the service, each with its own `api_key.issued`

### Automated verification
- [x] `bun test apps/api/src/routes/internal/keys.test.ts apps/api/src/services/` passes — 19 tests
- [x] `bun test packages/db/src/audit-events.test.ts` still passes (grant unchanged)
- [x] `bun run typecheck`, `bun run lint` clean (full suite green: 698 tests, 58 files)

### Manual verification
> Rebuild before verifying — `set -a && . ./.env && set +a && docker compose -f
> infra/docker-compose.yml up -d --build api` — for the reason phase 2 records.

- [x] Issue a key in the API, copy the plaintext, call `POST /v1/panels/{id}/evaluate` with it.
      *By the stakeholder, 2026-09-13*, as part of phase 5's end-to-end check: a key issued
      through `/internal/keys` evaluated live, trace `tr_01M2E3VPH2V3AE7AHE3Z5AKZCH`.
- [x] Revoke it; the same call now fails with `UNAUTHORIZED`.
      *By Claude, 2026-09-14*, against the running container: the same evaluation answered 200
      before the revoke and 401 after.
- [x] `SELECT * FROM audit_events` shows both events with a `request_id` that matches the
      response envelope.
      *By Claude, 2026-09-14* — `api_key.issued` and `api_key.revoked` each carried a
      `request_id` EQUAL to its own response envelope's. Worth noting because that is stronger
      than `keys.test.ts`, which asserts only the id's format and never equality.
- [~] `bun run scripts/mint-keys.ts` produces N usable keys, and a k6 run using several of
      them drives more than the ~1 req/s a single key allows — the measurement BREAKING_POINT
      v1 needs. **Producing v1 itself stays out of scope**; this only makes it possible.
      *Minting verified during implementation:* 5 keys minted against the seeded panel, each
      with its own `api_key.issued` at `actor_type='system'`, and the first one returned 200
      from a real `/v1` evaluation. A wrong `MINT_ORG_ID` was refused with nothing written.
      **The k6 run itself is still yours** — that is the half this phase only makes possible.
      **DEFERRED, not blocking.** Minting is verified; the k6 run is not done, and producing
      BREAKING_POINT v1 was declared out of M4's scope. It belongs with that work.

---

## Phase 4 — The catalogue client, and what the picker is allowed to claim

### Changes
- `apps/api/src/llm/catalogue.ts` — **new, and it must live here**: ADR-0016's
  `architecture.test.ts` fails the build on a provider hostname or outbound `fetch` outside
  `src/llm/`. Fetches models + per-model endpoints, caches in-process with a TTL, serves the
  last good snapshot when a refresh fails, `fetch` injected (ADR-0028) so tests run offline.
- `apps/api/src/routes/internal/models.ts` — **new.** `GET /internal/models` returning
  candidates with what the measurements say matters: price in/out, endpoint count, supported
  reasoning efforts, and whether reasoning is mandatory.
- `apps/api/src/routes/internal/judges.ts` (validation half) — **new.**
  `POST /internal/judges/validate-pin` calling the existing `validatePin`, returning
  `{ok, reason?, available_endpoints?}` verbatim.

**What this phase must NOT do**, from the measurements
(`thoughts/shared/research/2026-08-30_model-tier-measurements.md`):
- Gate on `supported_parameters`. It is a **union across endpoints** — `claude-sonnet-5`
  advertised structured output with 3 of its 9 endpoints unable to do it — so it describes the
  best any endpoint can do rather than what the one that answers will. The catalogue
  POPULATES; `validatePin` GATES. (This bullet also cited haiku breaking the contract 4 of 4;
  that example was fixed on 2026-08-31 and is now history — Deviation 23.)
- Warn "this model always reasons" from `reasoning.mandatory`. That would be false for
  `gemini-3.5-flash-lite`, which is `mandatory: true` and reported **0 reasoning tokens** at
  `minimal` across three runs — the cheapest and fastest model measured.
- Present cross-lab tiers as equivalent. There is no `gpt-5.6-mini`; the nearest peer is a
  generation behind.

### Steps
- [x] Catalogue client with TTL cache, last-good-snapshot fallback, injected `fetch`
- [x] `GET /internal/models` returns price, supported efforts, mandatory flag — **endpoint
      count moved to its own route, see Deviation 18**
- [x] `POST /internal/judges/validate-pin` surfaces `reason` verbatim, never as an error envelope
- [x] Tests: a failing refresh serves the previous snapshot and logs at `warn`; a cold start
      with no network returns an explicit empty-with-reason rather than a silent empty list
- [x] `architecture.test.ts` still passes with the new outbound call inside `src/llm/`

### Automated verification
- [x] `bun test apps/api/src/llm/catalogue.test.ts` passes — 14 tests, offline
- [x] `bun test apps/api/src/architecture.test.ts` passes
- [x] `bun run typecheck`, `bun run lint` clean (full suite: 723 tests, 60 files)

### Manual verification
> Rebuild first — `set -a && . ./.env && set +a && docker compose -f
> infra/docker-compose.yml up -d --build api`.

- [x] With a real `OPENROUTER_API_KEY`, `GET /internal/models` returns a populated list whose
      numbers match the measurement table for the six models already measured.
      *Note:* the catalogue itself is PUBLIC and needs no key — verified during
      implementation, 445 models over one unauthenticated request. The key is what
      `validate-pin` needs, not the list.
      *By Claude, 2026-09-14, through `/internal/models`.* The table holds EIGHT distinct models,
      not six, and all eight were compared on $/M in→out: **seven match, one does not.**
      `z-ai/glm-5.3-flash` was recorded at 0.07/0.25 on 2026-08-30 and lists at 0.15/0.50 today.
      The raw public API agrees with our endpoint, so it is not a parse error. It is also NOT
      established that the price changed: the `:batch` variant lists at 0.075/0.25, which is what
      the 2026-08-30 row may have recorded. Either way, see the 6c note on mockup data.
- [x] Validate a pin for `anthropic/claude-haiku-4.5`. **This one costs a real provider call**,
      which is the point of it: nothing static can answer the question (ADR-0053).
      **The expectation in this step was WRONG and is corrected here** — it said to confirm a
      failure about rationale length. Run 2026-09-13, haiku **passes**: `ok: true`,
      `available_endpoints: 3`, served by `anthropic/claude-4.5-haiku-20251001`. That is the
      right answer, not a regression: the cap that failed it 4-of-4 on 2026-08-30 was split
      on 2026-08-31 into a prompt-stated target and a far looser refusal bound, and no
      `maxLength` is sent any more. See Deviation 23.

---

## Phase 5 — Panel and judge creation: the first write path for immutable versions

### Changes
- `apps/api/src/repositories/panels.ts` — add the write half beside `findLivePanel`:
  `insertPanel`, `insertPanelVersion`, `insertJudge`, `insertJudgeVersion`,
  `linkPanelVersionJudge`, `activatePanelVersion`.
- `apps/api/src/services/create-panel.ts` — **new.** One transaction, in the order the seed
  proves is legal: `panels` → `panel_versions` → `judges` → `judge_versions` →
  `panel_version_judges` → then `UPDATE panels SET current_version_id`. **Activation is a
  separate act from creation** and cannot be folded in — the version must exist before it can
  be pointed at.
- `apps/api/src/routes/internal/panels.ts`, `judges.ts` — **new.** Create panel + judges,
  list panels. Behind `requireRole('admin', 'engineer')`.
- Audit: `panel_version.created`, `judge_version.created`.

**The constraints this phase is boxed in by**, all already enforced by Postgres:
- `UPDATE`/`DELETE` are REVOKED from the app role on `panel_versions` and `judge_versions`
  (migration 0005). **There is no draft row.** The wizard's draft is client state until
  submit; anything else needs an ADR.
- Every `llm` judge carries a `model_pin`, `fake:` ones included (ADR-0025) — the CHECK is
  the mirror of the model/type rule.
- `weight > 0` and NOT NULL, polarity two-valued, `required` present (ADR-0034, ADR-0035).
- The pin is validated by a real call BEFORE the row is written (ADR-0026). An unsatisfiable
  pin is a form error, never an exception.

### Steps
- [x] Repository writes for all five tables plus activation
- [x] `createPanel` service: one transaction, validate every `llm` pin before insert — validation
      runs BEFORE the transaction opens, not inside it; see Deviation 24
- [x] `model_pin_validation` written from the validating call (`available_endpoints`, `served_by`)
- [x] Routes, org-scoped from the session, role-guarded
- [x] `panel_version.created` / `judge_version.created` audit rows
- [x] Tests: a rejected pin creates NO rows; a failure HALFWAY through the transaction creates no
      rows; weight 0 and missing polarity are refused by the database, not only by the schema
      (asserted as SQLSTATE 23514 and 23502); the created panel answers
      `POST /v1/panels/{id}/evaluate` with a key from phase 3

### Automated verification
- [x] `bun test apps/api/src/services/create-panel.test.ts` passes — 10 tests
- [x] `bun test apps/api/src/routes/internal/panels.test.ts` passes — 11 tests, including the
      end-to-end demo moment
- [x] `bun run typecheck`, `bun run lint` clean (full suite: 744 tests, 62 files)

### Manual verification
> Rebuild first — `set -a && . ./.env && set +a && docker compose -f
> infra/docker-compose.yml up -d --build api`.

- [x] Create a panel with one `fake:` judge and one real `openrouter:` judge; confirm both
      froze with a populated `model_pin_validation`. *Done 2026-09-13 by the stakeholder:*
      panel `mixed-judges` — `is-missing-repro` on `fake:deterministic` froze with 0 endpoints,
      `is-p0` on haiku froze with **3**. The difference is the point: only the real call
      measured it.
- [~] Attempt a judge whose pin cannot be satisfied; confirm nothing is written and the reason is
      legible. **This step originally named haiku, and that expectation is stale** — haiku now
      passes (Deviation 23). Use a quantization constraint instead: every one of haiku's 8
      endpoints reports `unknown` quantization (observed 2026-09-13), so pinning
      `"quantizations": ["fp4"]` should leave no endpoint to serve it. Costs one real call.
      **Still unconfirmed at PR time, and it is a PREDICTION, not an observation.** If the
      provider treats `unknown` as satisfying any precision constraint, this returns 201 and the
      step needs correcting again — the haiku lesson from Deviation 23, one step later.
      **DEFERRED, not blocking.** The rejection PATH is proven — `create-panel.test.ts` and
      `panels.test.ts` assert that a refused pin writes nothing and lands at `judges.N.model`
      through the real validation code — but no live provider has yet refused a pin here, and
      the one-call cost was not spent without the stakeholder's say.
- [x] Evaluate against the new panel with a key issued in phase 3 — **end to end with no seed**.
      *Already asserted by `panels.test.ts`*, against the fake provider. *Done 2026-09-13 by the
      stakeholder against the real one:* `mixed-judges` evaluated live with haiku serving
      `is-p0`, trace `tr_01M2E3VPH2V3AE7AHE3Z5AKZCH`.

---

## Phase 6 — The console's frame: flow map, shell, then the wizard screen · HUMAN REVIEW GATE

Phase A resumes for the console's FRAME plus one room (decision 1, revised 2026-09-11). The
other two load-bearing screens stay paused, and the six harvest blockers stay open — none of
them gate any artifact here.

**Why the frame is in scope and the other screens are not.** The console's navigation model
was decided inside `console-trace-explorer`, a screen that was deleted and whose successor the
BRIEF defers as unstyled. The decision survives only in the harvest: *"THE APP SHELL LIVES
HERE. Persistent left rail with the classifier switcher, section nav, and saved views."* It
names a "classifier switcher" — vocabulary ADR-0019 retired — and phase 1 has since added an
**org** switcher. So the console shell currently has two switchers, a nav and a role indicator
that no reviewed artifact describes, and a wizard drawn without one would invent all of it
implicitly. Drawing the remaining screens instead is the failure this project already ran
once: four mockups made six product decisions ahead of PRODUCT.md, which is why Phase A is
paused at all.

**Order within the phase is load-bearing:** the flow map says what exists, the shell reflects
it, the wizard is drawn inside it. A sidebar cannot be designed before its contents are known.

### 6a — `mockups/CONSOLE_FLOW.md`
A plain document, not a design. Every console screen M4 → M8, how a user reaches each, and
what the entry points are. This is where "does the app flow cohesively" is actually answered:
flow is an information-architecture property, and a map answers it for a fraction of what
drawing eight screens costs — without inventing the contents of screens whose product
decisions are unmade.

- [x] Every console screen named, with its milestone and its entry point — plus its SCOPE
      (org or panel), which the shell's two switchers turn out to need; see Deviation 32
- [x] Screens that do not exist yet marked as such, so the map is a plan rather than a claim
- [x] Referenced from `mockups/BRIEF.md`
- [x] **Approved by the stakeholder, 2026-09-14** — taking the recommendation on all eight review
      questions (CONSOLE_FLOW.md §7). Q5 had none to take and is carried to M5.

### 6b — `mockups/console-shell.html`
The frame, reviewed on its own terms. **Navigation is a persistent left SIDEBAR** (stakeholder
decision, 2026-09-11), which re-confirms the harvest's orphaned decision rather than replacing it.

- [x] Sidebar: section nav, populated from the flow map
- [x] **Org switcher** — reads the membership list phase 1 returns from `/internal/me`
- [x] **Panel switcher** — the harvest's "classifier switcher" in current vocabulary (ADR-0019)
- [x] Signed-in identity and role indicator, and the way out
- [x] Where a modal appears (the one-time key reveal needs one) and where errors surface
- [x] Sections M4 does not build are drawn **visible but inert**, so the shell is honest about
      where the app is going without committing to those screens' contents — with the hidden
      alternative one click away, because open question 1 is decided at this review
- [x] `data-surface="console"`, plain HTML + CSS on `tokens.css`, header comment per the BRIEF.
      No JS: switchers are `<details>`, review states are `:target` + `:has()`. Rendered and
      checked in a browser across all eleven states, 2026-09-14, by Claude
- [x] **r1 reviewed by the stakeholder, 2026-09-14 — and the navigation model changed.** See
      Deviation 34. r2 redrawn to it and checked in a browser across all fourteen states
- [x] **r2 approved by the stakeholder, 2026-09-15** — with inert sections greyed and
      milestone-labelled (open question 1), the tokens gaps reclassified as phase 7 work
      (Deviation 36), and the "No organisation" dead end accepted for M4

### 6c — `mockups/panel-create.html`
The wizard, drawn INSIDE the approved shell.

- [x] Panel details → judges (question, polarity, weight, `required`) → model picker → review
- [x] Model picker shows cost, measured latency **and its spread**, and the endpoint count
      surviving the pin. A median would have hidden `flash-lite` at 847–972 ms against
      `haiku` at 3078–15092 ms — the spread is the number that matters to a caller
- [x] The effort dial's per-model cost and latency consequence (one model's own range spanned
      1.8x cost and 1.7x latency, and two of its efforts were indistinguishable)
- [x] Where quantization is offerable, what constraining it **costs in failover** — 13
      endpoints down to 6, most of the loss being endpoints that never declared a precision,
      shown beside today's live split (27 endpoints, 9 of them undeclared)
- [x] The unsatisfiable-pin form error, carrying a real reason string — `REASONS.unavailable`
      from `llm/validate-pin.ts`, verbatim
- [x] The one-time key reveal, and that it cannot be shown again — the shell's modal, reached
      from the created state
- [x] Realistic data drawn from the measurement table — no lorem ipsum (BRIEF rule).
      **Re-pull prices from `GET /internal/models` rather than copying the table.** One of its
      eight rows no longer matches the live catalogue (`z-ai/glm-5.3-flash`, see phase 4), and a
      reviewed screen showing a stale price would carry it into phase 8 as an approved design.
      Latency and endpoint counts are measurements with dates and may be quoted as such.
      **Done, and the re-pull earned itself twice** — see Deviation 37.
- [x] **Resolve open question 3 at the 6c review, before the wizard is drawn as final** — it is a
      product decision, and the mockup must not make it by default. **Answered in conversation
      2026-09-15 and reframed by ADR-0060 — see Deviation 38.**
- [x] **Approved by the stakeholder, 2026-09-15** (r3), with the annotation gate set at 50 as a
      floor and 100 as the ideal first pass

### Also
- [x] `mockups/BRIEF.md` records the partial resume, the sidebar decision, and the three artifacts

### Automated verification
- [~] `bun run lint` clean (static files; this is a formatting check) — **clean, and it checks
      nothing here**: `biome.json` excludes `!mockups`, and Biome does not read Markdown. See
      Deviation 33. Re-run at the end of the phase regardless.

### Manual verification
- [x] **Human review and approval of the flow map, then the shell, then the wizard — in that
      order.** Done 2026-09-14/15, and the order earned itself: each artifact's review changed
      the one before it (Deviations 34, 39, 41). Phase 7 is unblocked.

---

## Phase 7 — The frame, built: shadcn/ui, the converted tokens, and the shell (D17 / ADR-0046)

Phase 7 now builds the shell rather than only re-skinning screens (stakeholder, 2026-09-11).
Building the frame here is what stops phase 8's three screens from each inventing their own
layout — they become things that go *inside* something that already exists.

### Changes
- `apps/web` — Tailwind + shadcn/ui installed and configured in `vite.config.ts`.
- `apps/web/src/styles/tokens.css` — **the conversion.** `mockups/tokens.css` rewritten into
  shadcn's theming convention, under the two rules ADR-0046 makes part of the decision:
  - shadcn's names are **aliases onto ours**, never the reverse. Our
    `--color-line-soft`/`--color-line`/`--color-line-strong` must not be flattened into its
    single `--border`, and it has no `data-density` equivalent at all.
  - The **selector convention stays ours** — three attribute axes (`data-tone`,
    `data-surface`, `data-density`), not a `.dark` class — via Tailwind v4 `@custom-variant`.
- `apps/web/src/components/shell/` — **new.** The sidebar shell from 6b: section nav,
  `org-switcher.tsx` (moved here from phase 8 — it is shell furniture, not a screen),
  `panel-switcher.tsx`, the role indicator, the modal and error slots.
- `apps/web/src/routes/root.tsx` — becomes the shell's mount point rather than an ad-hoc header.
- `apps/web/src/routes/{login,traces}.tsx` — re-skinned and moved inside the shell (login
  stays outside it: there is nothing to navigate when signed out). Doing the existing screens
  here proves the conversion and the shell on real screens **before** the wizard depends on both.
- `apps/web/src/components/ui/*` — the shadcn components actually used, copied in (ours to
  maintain; ADR-0046 names that cost).

### Steps
- [x] Tailwind + shadcn configured; build produces a working bundle (Claude — `bun run --cwd
      apps/web build`, 626 kB / 201 kB gzipped, up from 437 kB / 139 kB)
- [x] Token conversion complete, with a comment naming ADR-0046 and the alias rule (Claude)
- [x] Every value in the approved palette still reachable — nothing dropped in translation
      (Claude — `diff apps/web/src/styles/tokens.css mockups/tokens.css` reports **zero** lines
      present only in the approved file; §1–§5 are verbatim, see Deviation 42)
- [x] Sidebar shell built to the approved 6b screen, with inert sections greyed out and labelled
      with their milestone (open question 1, answered) — Claude. Both levels, the padlock/
      milestone distinction (r3), the foot, and the three error surfaces.
- [x] **Three values the 6b mockup could only stand in for arrive with the components, not from
      `tokens.css`** (6b review, Deviation 36). Checked against the COPY actually installed:
      - **rail width** — `sidebar.tsx:30` reads `const SIDEBAR_WIDTH = "16rem"`. The approved
        mockup's `calc(var(--space-16) * 4)` is 256px, the same number, so nothing is overridden.
      - **Dialog overlay** — shipped as `bg-black/50` in BOTH `dialog.tsx` and `sheet.tsx` (the
        mockup only predicted one). Replaced with `bg-overlay`, which §6 derives as
        `color-mix(in srgb, var(--color-bg) 72%, transparent)` — the mockup's own ratio, and
        tone-aware, where a literal is what tokens.css rule 3 forbids.
      - **toasts** — Sonner. **It does NOT sit under D17 as D17 was written**, and the answer was
        the stakeholder's: admitted, and D17 and ADR-0046 amended to say so. `duration: Infinity`.
        See Deviation 43 — `next-themes` came with it and was refused.
      - **`--spacing`** — aliased onto `--space-1`; verified in the built stylesheet, where
        `.p-4` compiles to `calc(var(--space-1) * 4)`.
- [~] Org switcher sends the active org header phase 1 validates; switching re-scopes the view —
      BUILT, typechecked, and its ONE-membership rendering verified in the running console (plain
      text at the foot, not a menu — 6b decision 5). **Switching itself remains unverified**: it
      needs a second membership no seed creates, and no phase has scheduled one. Carried, not
      forgotten. See Deviation 45 for the URL shape.
- [x] Existing screens re-skinned inside the shell; behaviour unchanged (Claude — login outside
      the shell, traces inside it. See Deviation 45: traces is still ORG-WIDE and says so.)
- [x] `apps/web/nginx.conf` still serves the bundle correctly (ADR-0020: SPA fallback, a real
      404 for a missing fingerprinted asset, `immutable` on `/assets/`, `no-store` on the shell)
      — Claude, against the REAL image rather than `vite preview`, which has its own fallback and
      would have proved nothing. `docker build -f apps/web/Dockerfile` then curl: `/p/x/traces`
      → 200 text/html; `/assets/nope-deadbeef.js` → **404**, not the shell; both the JS and the
      NEW CSS asset `immutable` with `Content-Encoding: gzip`; `/index.html` `no-store`. No
      config change was needed — the new CSS asset was already covered by `gzip_types`.

### Automated verification
- [x] `bun run --cwd apps/web build` succeeds (Claude)
- [x] `bun test apps/web` passes (Claude — 34 pass / 0 fail; the error-map exhaustiveness test
      is untouched by this phase and still green)
- [x] `bun run typecheck`, `bun run lint` clean (Claude — both required real fixes, not
      suppressions: Deviations 46 and 47)
- [x] `bun audit --audit-level=high` clean — Tailwind and shadcn's tree are new surface, and
      CI fails a PR on any high advisory (Claude — 458 packages, 0 at high. One MODERATE remains
      and is pre-existing: esbuild's dev-server advisory, reached through `drizzle-kit` and
      `vite`, below the level CI enforces and not introduced here.)

### Manual verification
- [x] The shell renders in both tones and both surfaces, matching `tokens-preview.html`
      (stakeholder 2026-09-16, in the running console; the computed-style check behind it is
      Deviation 43)
- [x] Diff the converted tokens against the approved `mockups/tokens.css` and confirm by eye
      that no approved value was lost — the check ADR-0046 exists to make possible
      (stakeholder 2026-09-16; `diff` reports zero lines present only in the approved file)
- [~] Switching org in the sidebar changes what the trace table shows, and cannot reach an org
      the signed-in account is not a member of — **the second half is verified**: a URL naming
      an org this account is not in renders the not-available state with the sidebar intact and
      never names the org (ADR-0057). The first half needs a second membership no seed creates.

**Two changes came out of the walk-through itself**, both stakeholder-raised and both fixed
before verification: the panel switcher kept its focus ring after a plain click and sat 4px
from the nav (Deviation 54), and the trace table's `Follow-up` column meant nothing to a reader
— it is `recorded_at`, now labelled **Recorded** to match the wire, with the explanation on
hover. **Whether that column belongs on a customer's table at all is open question 2's**, in
phase 8: it is an operator's signal (a null is how a dropped enqueue is found), not an answer
about the caller's evaluation.

---

## Phase 8 — The console: keys, the wizard, and the trace table

The rooms, built inside the frame phase 7 shipped, against the APIs from phases 3–5. Phase C
rule: rebuild clean from the approved brief; the mockup's HTML is never ported.

### Changes
- `apps/web/src/router.tsx` — routes for panels, the wizard, keys. Login gains the real
  redirect-after-401 its comment anticipates (`beforeLoad` + router context, now that the
  context earns itself).
- `apps/web/src/api/queries.ts` — reads for panels, keys, models; mutations for create and revoke.
- `apps/web/src/routes/panel-create.tsx` — the wizard. Draft is client state until submit
  (the grants leave no alternative), pin validated before the version freezes, unsatisfiable
  pin rendered as a field error.
- `apps/web/src/routes/keys.tsx` — issue, list, revoke; one-time plaintext reveal.
- `apps/web/src/routes/traces.tsx` — extended, not replaced.

### Steps
- [x] **Delete the throwaway GitHub button phase 2 added to `login.tsx`** (Deviation 11) and
      build the real one: feature-detected rather than always rendered, and using the
      redirect-after-401 below rather than a hard-coded `callbackURL` (Deviation 69)
- [x] All three screens mount inside the phase 7 shell; none invents its own layout (the shell
      itself was rebuilt mid-phase — ADR-0062, Deviation 58)
- [x] **ADR-0060 and ADR-0061, which land in this phase** (Deviation 41). Merged as #69. A panel is created
      COLLECTING and judges are not authored in the console at all:
      - `/v1` contract: an explicit state, `passed` and `score` nullable at the decision level
      - `evaluate`: a judgeless panel is a legitimate state — write the trace, run no judges,
        spend no tokens — replacing two `NOT_FOUND` refusals
      - `POST /internal/panels`: judges optional (the create-with-judges path stays for seeding
        and tests until M6 replaces it)
      - a key is issued WITH the panel, so the console's create flow is one step and the reveal
        is the panel's Overview rather than a dismissible modal
- [x] **Panel Overview, live at M4**: collecting state, progress toward the 50-trace annotation
      gate, and the integration snippet (curl / Node / Python, key masked on screen and real on
      the clipboard). A panel opens here
- [x] **Judges screen, read-only and locked** (Deviations 35, 41): the current version if one
      exists, a padlock and what opens it if not. Needs a panel read endpoint, org-scoped and
      role-guarded. **No authoring UI at M4** — that is M6, beside the taxonomy
- [x] Keys screen: issue with one-time reveal, list with `last4`, revoke with confirmation
- [~] Wizard: panel details → judges → model picker → review — **DROPPED at the 6c review.**
      Creation is one step (name, slug, threshold); the model picker's UI moves to M6 with
      judge authoring, its API half having shipped in phase 4
- [x] Trace table extended with the panel and judge context now available — KEY names added
      (Deviation 63), and **scoped to the open panel** by a required `panel_id` (Deviation 66).
      Judge context is not added; that is open question 2's to decide, with sort/filter
- [x] Redirect-after-401 via `beforeLoad` (Deviations 67–68)
- [x] Role-adaptive: an annotator does not see engineer-only surfaces (the UI mirrors the
      server guard; it never replaces it — CONVENTIONS "Keys & auth") (Deviation 70)
- [x] **`FORBIDDEN` needs to stop meaning two things in the console.** DECIDED with the
      stakeholder (ADR-0063, Deviation 72): "member of nothing" became a SCREEN — create your
      organisation — read from `/me` as data, and `FORBIDDEN` now means wrong role only. Found in phase 2's
      manual verification: a GitHub account with no membership lands on *"Ask an owner of
      this organisation to grant you access"*, and there is no "this organisation" — the
      account is a member of none. `error-map.ts` keys off the CODE, and the server sends
      `FORBIDDEN` for two unrelated states: "a member of no org at all" (`sessionAuth`) and
      "your role in this org does not allow that" (`requireRole`, phase 1). The server's own
      messages distinguish them; the map cannot see that. Either surface the server's
      `message` for this code, or branch before the map is reached — **the "member of
      nothing" state is arguably a screen rather than an error**, since it is where a real
      product would offer to create an org, which is M8's gap. Decide here; do not paper over
      the copy.

### Automated verification
- [ ] `bun test apps/web` passes
- [ ] `bun run --cwd apps/web build` succeeds
- [ ] `bun run typecheck`, `bun run lint` clean
- [ ] `bun test` (full suite) green

### Manual verification
- [ ] **The full interviewer flow, on a database with no seeded panel** — rewritten by
      ADR-0060/0061 (Deviation 41): sign in with GitHub → create a panel in one step → copy the
      snippet → curl `POST /v1/panels/{id}/evaluate` → watch traces arrive against a COLLECTING
      panel, with the annotation gate counting up. No judges are authored, and that is the
      point. BUILD_SPINE's M4 demo line is rewritten to match.
- [ ] An annotator account cannot reach the wizard or the keys screen, in the UI **and**
      by direct API call
- [ ] The key plaintext is unrecoverable after the reveal is dismissed

---

## Decisions made
Each becomes an ADR stub at `/approve_plan`. Next free number after ADR-0046 is **0047**.

1. **The active org travels in a request header, validated against membership** — over a path
   segment (`/internal/orgs/:id/...`, which rewrites every route and every client call) and
   over a server-side "active org" on the session (which makes a second tab in another org
   silently change what the first tab is looking at). The header keeps routes org-implicit at
   the handler while making the org explicit at the boundary, so the filter stays in one place.
2. **`requireRole()` and the org switcher ship as one phase** — because a role is per-org
   (ADR-0014), so a guard resolving against "the first membership" would enforce the wrong row
   the moment a second exists.
3. **better-auth's organization plugin is NOT adopted** — ADR-0014 deliberately put `role` on
   our own `org_members`, and adopting the plugin's tables would relocate the decision that
   ADR into the auth library.
4. **Credential sign-in is disabled in production only**, not removed — the fresh-clone
   zero-secret boot (ADR-0009) is load-bearing for M0's demo moment and for CI.
5. **No `scopes` column on `api_keys` at M4** (stakeholder, decision 4). Stated assumption:
   keys are implicitly `evaluate`-only. **Accepted cost:** every key issued before the
   management API arrives needs a backfill, and M4 is the milestone that starts minting them
   in volume.
6. **M4 writes the first `audit_events` rows** — `api_key.issued`, `api_key.revoked`,
   `panel_version.created`, `judge_version.created`. M8 still owns the viewer, retention and
   export; this makes that screen a read over real history.
7. **The wizard's draft is client state until submit** — not a decision so much as the only
   representable option: migration 0005 revokes UPDATE and DELETE from the app role on both
   version tables. A mutable draft table would need its own ADR.
8. **The catalogue populates; `validatePin` gates** — a capability flag is not a guarantee of
   constraint enforcement, measured 4/4 on `claude-haiku-4.5`.
9. **The catalogue is an in-memory TTL cache with a last-good-snapshot fallback** (decision 7)
   — over a Postgres snapshot with a refresh job, which buys restart survival for a table, a
   migration and a job handler.
10. **The existing screens are re-skinned in phase 7, before the wizard is built** — so the
    token conversion and the shell are proven on screens that already work, rather than
    debugged underneath new ones.
11. **Phase A resumes for the console's FRAME plus one room** — a flow map, the shell, and
    `panel-create.html` — not for a screen alone, and not for every screen (stakeholder,
    2026-09-11, revising decision 1). Drawing one screen alone would have let it invent the
    app shell implicitly; drawing them all would repeat the failure that paused Phase A, since
    four mockups previously made six product decisions ahead of PRODUCT.md. The other two
    load-bearing screens and all six harvest blockers stay untouched.
12. **Console navigation is a persistent left SIDEBAR** (stakeholder, 2026-09-11). This
    re-confirms the decision the deleted `console-trace-explorer` mockup made and that survived
    only in the harvest, restoring it as a reviewed choice rather than an orphaned one. Its
    "classifier switcher" becomes a PANEL switcher (ADR-0019 retired `cls_`), beside the org
    switcher phase 1 introduces.
13. **The flow map precedes the shell, which precedes the wizard** — a sidebar cannot be
    designed before its contents are known, and a wizard drawn without a shell invents one.
14. **The shell is BUILT in phase 7, not phase 8** (stakeholder, 2026-09-11) — so phase 8's
    three screens are things that go inside something that exists, rather than three screens
    each inventing a layout that has to be reconciled afterwards.
15. **Sections the shell shows but M4 does not build are drawn visible-but-inert** — the shell
    is honest about where the app is going without committing to the contents of screens whose
    product decisions (harvest blockers 1–5) are still open.
16. **A non-member or unknown org answers `NOT_FOUND`, not `FORBIDDEN`** (stakeholder,
    2026-09-11) — the same posture `api-key-auth.ts` already takes, where a key scoped to
    another panel is `UNAUTHORIZED` rather than `FORBIDDEN` so the response does not confirm
    the other panel exists. Both auth paths now refuse the same way.
17. **Phase 3 ships `scripts/mint-keys.ts`, minting through the console's own service**
    (stakeholder, 2026-09-11) — over having k6 sign in and drive `/internal` (which couples the
    load harness to session auth and CORS), and over deferring it. BREAKING_POINT §8 ranks it
    first, and the seam is nearly free while the service is being written.

## Explicitly NOT doing
- **No client SDK.** ADR-0002 descoped it 2026-08-19; D5 records "no SDK"; `packages/sdk` has
  never existed. BUILD_SPINE and CONVENTIONS carried a stale line until 2026-09-11 and both
  are corrected. If one ever returns it is generated from the OpenAPI spec and supersedes 0002.
- **No public `/v1` management API.** The parking lot parks management CRUD until enterprise
  pull, with a dashboard-first promotion rule. M4's management surface is `/internal` only —
  which is also why the scopes question is deferrable.
- **No annotator UI polish, guest experts, or taxonomy tooling** (M4's own "Not now" list).
- **No quota enforcement** — M8, with billing and the ADR-0040 fail-open revisit.
- **No `annotator` surface**; the role is enforced, its console is M5.
- **No CD.** M8 leads with it (ADR-0029).
- **No BREAKING_POINT v1 rerun.** M4 makes the saturation number *measurable* and ships the
  minting script that makes it reachable (phase 3); running the load and rewriting the document
  is separate work.
- **Phase A stays paused** for `annotator-session` and `console-dashboard`, and the six
  harvest blockers stay open.

## Deviations

Recorded as they happen; decision provenance, not a changelog.

### Phase 1

1. **`findMembership(db, userId, orgId)` was not written.** The plan asked for
   `listMemberships` *plus* an org-scoped single read "for the validated single read". Once
   `AuthenticatedSession` carries `memberships` — which the same plan requires, so the console
   can render its switcher without a second round trip — the list is already in hand when the
   requested org is validated. A second query would run on every console request to re-fetch a
   row the middleware is holding, and the function would have no other caller, so it would ship
   as dead code with a test. The active org is resolved by filtering the list instead. Nothing
   about ADR-0047's validation changes: an org not in the list is refused.

2. **`Membership` carries `orgName` and `orgSlug`, via a join onto `orgs`.** The plan's
   membership shape was the three `org_members` columns. A switcher rendering `org_01J…` is not
   a switcher, so phase 6b/7 would have had to add either a join here or a second endpoint —
   and the plan's stated reason for putting `memberships` on the session is "so the console can
   render a switcher without a second round trip". The join serves that intent; adding it later
   would not have been cheaper.

3. **The org-resolution tests live in `middleware/session.test.ts`, an integration test against
   real Postgres and real better-auth.** The plan named that file, but it did not exist —
   `testing/fake-auth.ts` has pointed at it since M0 ("the tests that ARE about the session path
   use a real one, against a real database, in `middleware/session.test.ts`") and the tests had
   actually been written in `routes/internal/index.test.ts`. Creating it makes that pointer true
   and keeps the two concerns apart: `index.test.ts` owns "the two auth paths never cross",
   `session.test.ts` owns "which org is this request about". `require-role.test.ts` is a fast
   unit test with no database, since resolving *which* role applies is `sessionAuth`'s job and is
   proven next door.

4. **`ACTIVE_ORG_HEADER` was added to the CORS `allowHeaders` list**, which the plan's change
   list did not mention. A custom request header is not on the CORS safelist, so a browser
   preflights it and drops the request when the response does not name it. **No test in this
   repo can catch it** — `app.request()` sends no preflight — so it would have failed only in a
   real browser, and only once phase 7's switcher started sending the header.

5. **The guard is exercised by a probe route, not a real one.** No route registers
   `requireRole()` until phase 3's keys endpoints, so the plan's "an annotator hitting an
   admin-guarded route gets `FORBIDDEN`" has no admin-guarded route to hit yet. It is asserted
   against a probe mounted on the real app through the real error handler (the pattern
   `rate-limit.test.ts` established), so the guard does not ship untested for two phases.

6. **The active org is `active_org_id` on the wire, not `org_id`.** The plan wrote
   "`GET /internal/me` returns active org, role, and the membership list" without naming the
   field. Shipped as `org_id`, it sat directly above `memberships[].org_id` and read as a
   duplicate of one of them — a stakeholder hit that confusion on the first look at a real
   response. It is not a duplicate: it is the org THIS request resolved to, and with no header
   sent the client cannot derive it without reimplementing the first-membership fallback. The
   name now says so. The session field stays `session.orgId` — there is only one org on a
   session, so the ambiguity exists only on the wire, beside the array.

   `apps/web/src/routes/root.tsx` already consumed the old name and its typecheck failed on the
   rename, which is the internal surface's stated guarantee working as designed: the contract is
   Hono's RPC types, so a console route changing shape breaks the build rather than the page.

### Phase 2

7. **The GitHub pair is validated as a PAIR in every environment, not only required in
   production.** The plan said "optional locally, required in production", which leaves half a
   pair legal outside production. Half a pair is not a supported state anywhere: the provider
   registers only when both are present, so one variable set and the other misspelled produces
   a console with no GitHub button and nothing in the logs to explain it. That is the exact
   runtime surprise `config.ts` exists to prevent (CONVENTIONS "Config"), so the missing half
   is named at boot. `auth.test.ts` asserts the other side of the same rule — that `auth.ts`
   really does refuse to register on one credential — because if it ever did, the boot check
   would be rejecting a configuration that worked.

8. **`scripts/seed.ts` pins `NODE_ENV: 'development'` in its own `createAuth` call.** The seed
   creates the demo account by calling `signUpEmail`, which M4 now disables in production. The
   seed already passed literal values for the other three fields on the reasoning that they
   "only have to be well-formed"; reading the ambient `NODE_ENV` instead would make
   `NODE_ENV=production bun run db:seed` fail inside better-auth with an error about a disabled
   provider — describing the library's state rather than the mistake. Seeding a production
   database is not a supported act, and if it becomes one it needs its own door.

9. **`auth.test.ts` is an integration test against real Postgres**, not a unit test. better-auth
   writes an OAuth state row before it will return an authorization URL, so the happy path does
   not exist without a database — a fake one fails at `db.insert`. The test captures each state
   it causes and deletes exactly those rows, which was verified rather than assumed (0 rows
   before, 0 after).

10. **The test pins the GitHub redirect URI.** Not in the plan, and worth its own line because
    it is the value that breaks this setup most often: it is DERIVED (`API_BASE_URL` +
    `basePath` + `/callback/github`), not configured, so nothing else would catch it changing,
    and a mismatch is reported by GitHub rather than by us. `.env.example` tells the operator to
    paste the same string, and this assertion is what stops the two drifting.

11. **A throwaway GitHub button was added to `apps/web/src/routes/login.tsx`, in phase 2.**
    Not in this phase's scope, and added deliberately anyway (stakeholder, 2026-09-11).

    **The plan had an ordering bug.** Phase 2's manual verification says to complete a
    sign-in "with the GitHub button", and the login screen has only email and password —
    the button is not scheduled until phase 8, six phases after the check that needs it.
    The step as written could not be satisfied when it was asked for.

    The alternative was to verify by pasting `sign-in/social` curl output into a browser,
    which does exercise the whole round trip. It was rejected as the *verification* because
    the thing phase 2 ships is a door for people, and driving it the way a person will is
    worth more than driving it the way a script would.

    It is marked as disposable in three places — a block comment on the component, an inline
    comment beside the markup, and the phase 8 step above — because an undeleted placeholder
    is how a screen invents its own layout, which is the exact failure decisions 13 and 14
    reorganised the phases to prevent. Three properties are deliberately absent, so it cannot
    be mistaken for a partial implementation: no design, no feature detection (it renders
    even when the API has no GitHub credentials and the request comes back
    `PROVIDER_NOT_FOUND`), and no redirect-after-401.

12. **`infra/docker-compose.yml` now forwards `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
    to the `api` service.** Missing from the plan's change list, and a real hole rather than
    a local inconvenience: `config.ts` read the variables and `.env.example` documented them,
    but the compose stack had no way to pass them in — so `docker compose up` could never
    demo GitHub sign-in, and the symptom was a button answering `PROVIDER_NOT_FOUND` against
    a correctly configured `.env`.

    Found by the stakeholder clicking the button, not by a test, and no test in this repo
    would have found it: every automated check constructs `createAuth` directly from a config
    object, so the gap lives strictly between `.env` and the container. The bare
    forwarding form is used, matching `OPENROUTER_API_KEY` — absent when unset, so
    `docker compose up` remains a zero-secret command.

    **Worth knowing for every later phase:** compose's project directory is `infra/`, so the
    repo-root `.env` is NOT read. Variables are forwarded from the invoking shell, which
    means `set -a && . ./.env && set +a` before `docker compose up`. The comment in the
    compose file now says so.

### Phase 3

13. **The test cannot delete its own audit rows, and that is the guarantee working.** The first
    draft cleaned up after itself and Postgres refused with SQLSTATE 42501 — *permission denied
    for table `audit_events`* — on the test's own connection. There is no privileged path for
    "it was only a test": the app role holds INSERT and SELECT, full stop. The rows are left
    behind and every assertion is scoped to an id minted fresh per run.

    A related fact worth recording, because it was uncertain until it was tried: dropping the
    ORG still works. `audit_events.org_id` is `ON DELETE SET NULL`, and a referential action
    runs as the table owner rather than as the caller, so the tenant row goes while the record
    that they existed stays.

14. **`panelBelongsToOrg` returns a boolean and lives in `repositories/panels.ts`.** The plan
    put the key-creation path entirely in `api-keys.ts`; the ownership check is a panel concern
    and belongs with panels (CONVENTIONS "one exported concern per file"). It deliberately does
    not return the row: a handler holding the panel would be one refactor away from rendering a
    panel it only asked permission about. A false answer is `NOT_FOUND` at the route, never
    `FORBIDDEN` — ADR-0057's posture, applied to panels.

15. **`repositories/executor.ts` is new.** The plan did not say whether the key row and its
    audit event share a transaction. They do, and that requires both repositories to accept
    either the pool handle or a transaction, so the type is derived from Drizzle's own callback
    parameter rather than written out. A key without its `api_key.issued` is a live credential
    with no provenance; an event without its key is a record of something that did not happen;
    and the audit log has no UPDATE, so neither is repairable after the fact.

16. **The key prefix is derived from `NODE_ENV`, not chosen by the caller.** CONVENTIONS names
    both `llk_live_` and `llk_test_` without saying who picks. This product has no test/live
    MODE the way a payments API does — one database, one set of panels — so the prefix is a
    fact about where the key was minted rather than a claim a request can make.
    `scripts/seed.ts` already mints `llk_test_` on the same reasoning.

17. **A test was added because a mutation defeated the suite.** Four mutations were run against
    phase 3; three failed tests as intended, and the fourth — adding `hash` to the list
    endpoint's response — passed all eighteen. The repository comment said the hash was excluded
    deliberately and nothing enforced it. It is a hygiene issue rather than a hole (the secret
    is 32 random bytes, so its SHA-256 is not reversible), but a documented intention with no
    guard is exactly what rots, so the assertion now exists and the mutation now fails.

### Phase 4

18. **`GET /internal/models` carries no endpoint count; `GET /internal/models/{id}/endpoints`
    does.** The plan asked for the count in the list. The live catalogue was checked before
    designing against it: `/models` returns **445 models and has no endpoint-count field at
    all**, so populating the list eagerly would mean one HTTP request per model per refresh.

    It is also the wrong number to lead with, which is the better half of the argument. The
    count that matters is how many endpoints survive THIS judge's pin — `claude-sonnet-5` had
    5 of 9, `gpt-5.6-sol` had 1 of 5 — and only ADR-0026's validating call knows it. The
    catalogue's raw total is the denominator, useful for "what would constraining quantization
    cost", and it is fetched per model on demand and cached separately.

19. **Fixtures are REAL trimmed responses, captured 2026-09-12**, in
    `apps/api/src/llm/__fixtures__/`. A hand-written fixture tests a parser against its own
    author's assumptions, which is how a field gets read from the wrong place and nobody
    notices until production. The catalogue endpoints are public and unauthenticated, so
    capturing them cost nothing and used no credential.

20. **`modelProvider` was hoisted into `AppDeps`.** `validatePin` takes a `ModelProvider`
    rather than the gateway — as `scripts/seed.ts` has called it since M1 — and the gateway
    exposes no provider. This is NOT a hole in "every provider call goes through the gateway":
    that rule is about `src/llm/` being the only place a provider is reached, which
    `architecture.test.ts` enforces and `validate-pin.ts` satisfies. What validation
    deliberately does not want is retry and a breaker — an unsatisfiable pin is an ANSWER, and
    a form check that tripped the circuit for real judge traffic would be worse than useless.

21. **`testing/fake-catalogue.ts` is new, and twelve `createApp` sites gained two deps.** The
    cost of a required dependency, paid the same way `meter` and `rateLimitStore` were.

22. **A second test was added because a mutation defeated the suite** — the same lesson as
    phase 3, in a subtler form. Parsing every price through a float passed all thirteen tests,
    because the fixture's own prices round-trip by luck: `String(Number('0.00001'))` is still
    `'0.00001'`. The assertion was testing a value that could not fail. It now uses
    `'0.0000001'`, which becomes `'1e-7'`, and a long decimal that loses digits outright.
    **Fixtures drawn from real data can hide a bug precisely because the real data is benign.**

23. **The haiku example is history, and four documents were still asserting it in the present
    tense.** Phase 4's own manual verification told the stakeholder to expect a failure about
    rationale length. Run against the live provider on 2026-09-13, `claude-haiku-4.5`
    **passed** — `ok: true`, 3 endpoints surviving the pin.

    (Wording note, because this line failed the secret scan once and cost a force-push.
    gitleaks' generic key rule matches any backticked token within roughly forty characters
    of the word that abbreviates "application programming interface", and a hyphenated model
    id is exactly that shape — the secret it reported was the model name itself. Write
    "provider" instead when a model id is nearby. Note also that the scanner reads COMMITS,
    not the working tree, so correcting the file is not enough once the text is committed.)

    It is not a regression and not a fluke. `packages/contracts/src/evaluate.ts` records the
    cause: until **2026-08-31**, one day after the measurement, `280` was sent as `maxLength`
    under `strict: true` and never mentioned in the prompt. Structured output constrains SHAPE,
    not size, so the cap was advisory on the wire and absolute on the way back in — a model was
    never told the limit and was then refused for exceeding it. The fix split it into
    `RATIONALE_TARGET_LENGTH` (280, stated in the prompt) and `RATIONALE_MAX_LENGTH` (1000, the
    refusal bound), and `judge-schema.ts` now sends no `maxLength` at all.

    **The correction was already in the repository when ADR-0053 was written on 2026-09-11.**
    `llm/validate-pin.test.ts` carries the re-measurement in a comment — *"told one, it
    returned 185-296 on 5 of 5 (re-measured 2026-08-31)"* — and the completed M1 plan says the
    same. So the real failure is not a model changing behaviour: it is a newer document citing
    an older measurement across a correction that was already written down, twice. An accepted
    ADR does not re-check its own evidence, and nothing in the process made it.

    **ADR-0053's decision is unchanged, because it never rested on that example.** Its other
    leg is untouched — `supported_parameters` is a union across endpoints, `claude-sonnet-5`
    advertising structured output with three of its nine unable to honour it — and the passing
    call demonstrates the point *better* than the failure did: the catalogue can say haiku
    exists and advertises structured output; only a real call says three of its endpoints
    satisfy this pin and which one answered.

    Corrected in ADR-0053 (amended, not retracted), `llm/validate-pin.ts` (stale since M1),
    `llm/catalogue.ts`, `routes/internal/models.ts`, `routes/internal/judges.ts`, both test
    files, and this plan. **The manual-verification step was the dangerous one** — it would
    have sent the next person hunting a bug that does not exist.

### Phase 5

24. **Pins are validated BEFORE the transaction opens, not inside it.** The plan said "one
    transaction … validate every `llm` pin before insert", which admits both readings. Inside
    would hold a database transaction — a pooled connection and its locks — open across N real
    provider round trips, measured at 3.3 seconds for a single haiku probe. So every pin is
    validated first, in parallel; if any fails, no transaction is ever opened and there is
    nothing to roll back. `scripts/seed.ts` has done the same since M1. The all-or-nothing
    guarantee for the WRITES is still one transaction, and a test proves it by forcing a
    failure after three rows are already written.

25. **`code` judges are refused, with a reason.** The plan did not mention them. `evaluate.ts`
    has no executor for them until M5, so every one reports `failed` on every evaluation; the
    schema has no column for what a code judge would check; and a `required` one would veto its
    panel on every call — permanently, since versions are immutable and the only way out is a
    new panel version. Refused at `judges.N.type` with a message naming M5, rather than silently
    narrowed to `llm`. The service's input type has no `type` field at all.

26. **No separate "create a judge" route; creation is one submit.** The plan listed
    `routes/internal/panels.ts, judges.ts` for "create panel + judges". A `pnv_` pins its judge
    set and both version tables are immutable, so adding a judge to an existing panel is not an
    insert — it is writing panel version n+1. Panel and judges are therefore one request, and
    `judges.ts` keeps only phase 4's `validate-pin`.

27. **A rejected pin on CREATE is a 422, where `validate-pin` returns 200.** Both are form
    errors, and the difference is principled rather than inconsistent: `validate-pin` answers a
    QUESTION, so "no" is a successful answer; `POST /internal/panels` is a COMMAND that could not
    be carried out. 422 with `issues` at `judges.N.model` and the reason verbatim, so the wizard
    renders each beside its own field. Every failing judge is reported, not the first.

28. **A ceiling of 16 judges per submit, as a cost control.** Not in the plan. Each `llm` judge
    costs one real, parallel validating call, so an unbounded array is an unbounded number of
    paid provider calls from a single form post.

29. **The unique violation is matched by CONSTRAINT NAME, not SQLSTATE alone.**
    `judges_panel_slug_key` raises the same 23505 as `panels_org_slug_key`, and a first draft
    would have reported a duplicate judge slug as "that panel slug is taken". A mutation
    confirmed the name check is load-bearing.

30. **A test fixture silently tested the wrong failure, for every case.** The first draft of
    `create-panel.test.ts` used `stub:good` as its model id. `modelRefOf` accepts only
    registered routes (`fake`, `openrouter`), so every judge was rejected as malformed BEFORE the
    stub provider was ever called — eight tests failed, but they would have failed for the wrong
    reason had they been written to expect failure. Corrected to `openrouter:stub/…` with the
    stub injected as the provider, which is the only way to reach the real validation path
    offline: `fake:` is short-circuited by `validatePin` and can only ever say yes.

31. **A mutation disproved a comment, and the comment was corrected rather than a test invented.**
    Six mutations were run; five failed tests. The survivor moved activation BEFORE the judge
    inserts, which the comment claimed "would briefly serve an empty panel". It would not: inside
    a transaction, READ COMMITTED readers see the pointer and the judges together or not at all.
    The guarantee is the transaction — and removing the transaction IS caught. Writing a test to
    make that mutation fail would have been testing Postgres's isolation rather than this code,
    so the claim was fixed instead. Third phase running where a mutation found a comment that
    sounded right and was not.

### Phase 6

32. **The flow map records each screen's SCOPE, and proposes a rule for the panel switcher.**
    The plan asked for screen, milestone and entry point. Drafting the map showed that is not
    enough to draw a shell with two switchers: the API is not uniform about panels —
    `GET /internal/traces` and `GET /internal/keys` are org-wide, `POST /internal/keys`
    requires a panel — so what the panel switcher changes on each screen is an IA question the
    shell cannot answer by being drawn. The map proposes a rule (§4) and puts it to review as
    Q1 rather than letting 6b decide it as a layout.

    A finding came out of the same pass: **`GET /internal/traces` is the one internal route
    with no `requireRole`**, so an annotator's session can read it. Harmless today — the rows
    carry no verdicts or confidence — but phase 8 extends the table with judge context, and
    harvest blocker 2 (confidence withheld from annotators) is open. Recorded as the map's Q3;
    not changed in code, because phase 6 is not application work.

33. **Phase 6's only automated check verifies nothing it produces.** `bun run lint` passes,
    but `biome.json` lists `!mockups` in `files.includes`, and Biome does not read Markdown in
    any case. The plan called it "a formatting check" for static files; it is not one for these.
    Left as is rather than widened: the mockups are disposable and hand-written HTML, and
    bringing them under a formatter now would be tooling for artifacts CLAUDE.md says are
    never ported. The real verification for this phase is the human review, which the plan
    already names as the gate.

34. **The 6b review reopened three answers the 6a review had just approved, and that was the
    process working, not failing.** The plan orders the flow map before the shell so the shell
    is drawn from known contents (decision 13). What it did not anticipate is that a drawn
    sidebar gets reviewed as a whole where a table of sections does not: the stakeholder saw
    the org switcher overstated in the top slot, a panel switcher above a Panels item, and
    org-level entries breaking a nav that otherwise read as one panel's — none of which was
    visible in `CONSOLE_FLOW.md`'s tables. The model became two levels in one sidebar (Home
    and a panel, with "← Home" out of a panel), the org moved to the foot, and organisation
    settings became admin-only and absent until M8.

    Superseded: flow-map Q1 (the All-panels mode) and Q8 (Keys top-level); Q6 (panel detail)
    now has a home as the panel's Overview; Q2 and Q7 amended. Plan decision 12 and ADR-0056
    named an org switcher and a panel switcher in the sidebar without an order — the ADR is
    **amended**, not superseded, because both still live there. New: **ADR-0059**
    (organisation settings are admin-only). Error surfaces split into three, and the silent
    org fallback became a not-found state. Record: `CONSOLE_FLOW.md` §8; decisions log,
    2026-09-15T02:45Z (three entries). Fine-tunes' level was raised and deliberately deferred
    to M7 planning; the stakeholder currently reads it as one panel's judges.

35. **A Judges section was added to the shell, live at M4, with a read endpoint phase 8 did not
    have.** Found by the stakeholder after r2 was drawn: r2 folded a panel's judges into its
    Overview, which is inert until M6, so at M4 — the milestone that creates judges — there was
    nowhere to see them once the wizard closed. Phase 8 therefore gains a Judges screen and the
    read it needs; the phase 8 step list carries it. The judge's own page (its traces, its
    alignment) is recorded as direction and deferred, with two structural calls made now: it
    lives inside Judges rather than as a third sidebar level, and M4 judge rows do not link.
    Record: `CONSOLE_FLOW.md` §8 (R8).

36. **The 6b mockup's "tokens gaps" were reclassified as phase 7 conversion work, not
    `tokens.css` edits.** r1 and r2 flagged that `tokens.css` has no layout-dimension or scrim
    tokens and proposed that phase 7 name them. The stakeholder's correction: ADR-0046 already
    decided that `tokens.css` is converted INTO shadcn's theming convention, so these values come
    with the components. The mockup's rail width now matches shadcn Sidebar's default, and phase
    7 carries a step for the three values to verify against the installed copies. Recorded as a
    deviation because the mockup had framed a solved question as an open one.

37. **The live catalogue disagreed with the measurement table again, on the same row, in a new
    direction.** The plan told 6c to re-pull prices rather than copy the table, because
    `z-ai/glm-5.3-flash` had moved between 2026-08-30 (0.07/0.25) and phase 4's check
    (0.15/0.50). Pulled 2026-09-16T00:31Z through this repo's own catalogue client, it now lists
    **0.10/0.3333**, and its endpoint count has gone from 20 to 27 with a different quantization
    split (fp8 ×15, undeclared ×9, fp4 ×2, nvfp4 ×1). Every other row still matches. The mockup
    therefore labels prices as live-with-a-timestamp and measurements as dated, and never mixes
    them in one number. **The pull was done through `createCatalogue` directly rather than
    through `GET /internal/models`**, which needs a session and a running stack: same code path,
    same shaping, no container.

38. **Open question 3 was answered, and the ADR-0060 conversation reframed it first.** The plan
    asked whether the wizard should steer authors toward judges that GATE rather than WORK, with
    four options. The answer is option (b) — explanatory copy — but aimed somewhere else than the
    plan imagined: **at the payload, not at the wording of the question.** The stakeholder's
    argument is that judges cannot be authored before error analysis at all, so a wizard that
    polices question wording is policing a guess that is meant to be replaced. What cannot be
    repaired later is a trace with none of the agent's work in it, because no annotation pass can
    find failure modes in data that contains no agent behaviour. So step 1 teaches `artifact` and
    `context` with one generating and one deciding example, and step 2 says plainly that the first
    judges are provisional.

    Option (c) — asking "does your agent make or decide something?" and shaping the form from the
    answer — was ruled out on a checked fact rather than taste: it needs judges to declare their
    context keys, and no such column exists. `context` is an opaque string map on the trace.

    **The conversation also produced ADR-0060** (a panel can collect before it judges), which is
    the real fix and lands at M5. The mockup points at it rather than pretending M4's order is the
    product's order.

39. **6c was redrawn at review: the ORDER became a step, and the rail was not the approved one.**
    Two corrections from the stakeholder on r1. (a) The rail had been hand-copied into the wizard
    in simplified form — Home unmarked, a disabled "Not yet created" box where the approved
    "Choose a panel" switcher belongs — so the first screen drawn inside the approved shell was
    not actually the approved shell. It is now that markup verbatim. **Worth a line because phase
    7 builds the shell once and phase 8's screens must not each re-invent it**, which is the
    failure decisions 13 and 14 reorganised the phases to prevent, reappearing as a copy-paste.
    (b) More substantially: r1 kept judge authoring as the only path and excused the order in a
    paragraph, which the stakeholder read — correctly — as going back on the ADR-0060 conversation
    one message after it. r2 makes the choice **step 2**: *collect first* (recommended, marked
    M5) or *add judges now* (what M4 can do). Both outcomes are drawn, so the screen is the spec
    for M5's flow as well as M4's, and what M5 changes is which path is recommended rather than
    the screen. Option (D) — pulling ADR-0060 into M4 — was offered and not taken: the wizard's
    backend is merged (#63) and M4's demo needs judges to have verdicts to show.

40. **The wizard ends in runnable starter code, and every panel is created with a key** (r2,
    stakeholder). Neither was in the plan, and the second is a change to what phase 8 BUILDS
    rather than to how it looks.

    The screen now carries curl / Node / Python tabs with copy-to-clipboard, the key masked with
    a reveal toggle, and a comment on every field saying what to send — `artifact` is what the
    agent produced or decided about, `context` is what a judge needs including the agent's own
    decision — plus the response lines a caller actually uses (`passed` for a gate, `complete`
    for a partial result, `trace_id` for what an expert later annotates). Written against the
    contract rather than from memory: `Authorization: Bearer`, the optional `Idempotency-Key`
    header, and `data.passed` — **not** `data.decision.passed`, which is what the first draft of
    this deviation's snippet said before `evaluate.ts` was re-read.

    **Auto-issuing the key follows from the snippet**, not from convenience: a starter example is
    useless without a credential in it, and the plaintext exists exactly once. So the reveal stops
    being a dismissible modal on this path and becomes the success screen itself — a modal that
    can be closed would strand a key nobody copied. `POST /internal/panels` issues no key today,
    so phase 8 creates one immediately after the panel (or the service does both in one
    transaction); if that second step fails the panel simply has no key, and the Keys section
    issues one. The shell's modal stays for keys issued later.

    **One property worth keeping through phase 8:** the same snippet serves a collecting panel and
    a judging one. The call does not change when judges arrive — only what comes back does.

41. **The wizard was dropped, ADR-0060 moved into M4, and judge authoring left the milestone.**
    The largest change this phase has made, and it came from the stakeholder specifying the
    creation flow: one step (name, slug, threshold), then the panel's own home as the onboarding
    screen — collecting state, progress toward an annotation gate, and the snippet. That is how
    every data-first service onboards, and **it cannot be built with ADR-0060 at M5**:
    `POST /internal/panels` requires at least one judge and `evaluate` refuses a judgeless panel,
    so approving the screen would have had phase 8 build the wizard its own review rejected.

    **The gate's justification is provenance** (ADR-0061, new): a judge must cite the traces and
    annotations that produced it, because alignment scores, the contribution ledger and the audit
    log all rest on "which traces, annotated by whom, led to this judge". A free-form judge severs
    that chain at its origin and nothing later repairs it. So judge authoring leaves M4 entirely
    and lands at M6 beside the taxonomy, the Judges section ships locked with a padlock, and
    **the capability-gated model picker's UI moves to M6** — its API half (catalogue,
    `validate-pin`, endpoint accounting) having already shipped in phase 4, which is what makes
    the move cheap rather than wasteful.

    Consequences recorded elsewhere: ADR-0060 amended to M4; ADR-0061 added; BUILD_SPINE's M4
    deliverables and demo moment rewritten, M5's lead paragraph reduced to what it still owns;
    PRODUCT.md 5.2 carries the gate; `CONSOLE_FLOW.md` §3, §5 and R9; `console-shell.html` r3
    (Overview live, Judges padlocked — two nav items, needing a nod rather than a re-review);
    `panel-create.html` r3. **Open and not decided:** whether 50 is the right floor, whether it
    should be per-panel, and how alignment sessions are reached once judges are authored this
    way (carried to M6 by ADR-0061).

### Phase 7

42. **§1–§5 of the converted `tokens.css` are VERBATIM, and the file is excluded from Biome to
    keep them that way.** ADR-0046's last consequence is that the conversion is "reviewable as a
    diff against a file with an existing approval, so a lost or altered design token is visible
    rather than inferred". That only works if the diff is otherwise empty — so the converted file
    is the approved file with a header above it and two new sections below it, and
    `diff apps/web/src/styles/tokens.css mockups/tokens.css` reports **zero** lines present only
    in the approved copy.

    Biome broke it on first run: it lowercases every hex literal and collapses the blank lines
    between palette blocks, changing **61 lines** of approved source and leaving the check
    reporting noise instead of changes. The file is now in `biome.json`'s exclude list, beside
    `mockups` and for the same reason. §6 and §7 are hand-formatted.

    **Two things had to be enabled or removed to get there**, both worth knowing:
    `biome.json` needed `css.parser.tailwindDirectives`, without which Biome reports every
    `@theme` and `@custom-variant` as a parse error and then refuses to format the file at all.
    And **`biome.json` is strict JSON, not JSONC**: a `//` comment explaining the exclusion makes
    Biome reject its own config. The explanation lives in `tokens.css`'s own header instead.

    That one cost a wrong diagnosis worth recording. The comment made Biome fall back to config
    DISCOVERY, which walked into a stale git worktree under `.claude/worktrees/` and reported
    "found a nested root configuration" — an error about a directory that had nothing to do with
    the change. The worktree has since been removed (clean tree, no stash, HEAD already an
    ancestor of `main`, 512 MB reclaimed), and the comment STILL breaks the config, which is the
    real rule. **The misleading error was the environment; the cause was the comment.**

43. **The alias layer is ONE `@theme inline` block, not a per-tone copy — and that was measured,
    because the comment explaining it was wrong the first time.** §2 and §3 repeat themselves in
    full because a custom property's `var()` references resolve where the property is DECLARED,
    so `:root { --card: var(--color-surface) }` would freeze at the light value. `@theme inline`
    declares nothing: Tailwind emits the value into the utility, so `bg-card` compiles to
    `background-color: var(--color-surface)` and resolves at the element.

    The first draft's comment claimed `inline` "means these four names are never emitted as CSS
    variables". **It does emit them** — into `@layer theme`, where §1's unlayered declarations
    beat them. The behaviour is the same and the reason is not, so the comment was corrected to
    the measured one. Verified in a browser against the BUILT stylesheet, not reasoned about:
    console preset → `rounded-md` 4px on `#161A21`; annotator preset → 6px on `#FFFFFF`;
    `data-tone="light" data-density="compact"` → white at 4px and `--type-ui` 13px, so the two
    axes still compose independently; `--radius-md` stays 6px in all three while
    `--radius-control` follows density, so there is no cycle and no clobber.

44. **`shadcn add` WRITES INTO THE THEME FILE, and what it wrote is the decision ADR-0046 did not
    take.** Adding `sidebar` appended a `.dark { --sidebar: hsl(240 5.9% 10%); … }` block — eight
    literal colours, in shadcn's vocabulary, keyed off a `.dark` class — and spliced a matching
    light set INLINE onto an approved line in §1, mid-file, where a diff would show it as an edit
    to `--radius-mark`. Both were removed and §1–§5 rebuilt from the approved source.

    Recorded because it is not a one-off: every future `shadcn add` will do it. A standing note
    now sits at the foot of `tokens.css` saying to diff the file after each one.

    **Three copied components also reached past our tokens**, all silently: `dialog.tsx` and
    `sheet.tsx` with `bg-black/50`, `sidebar.tsx` with raw `var(--sidebar-border)` /
    `var(--sidebar-accent)`, and `sonner.tsx` with `var(--popover)`. The last three matter more
    than they look: **§6 aliases shadcn's names for utility GENERATION only**, so `bg-popover`
    works and a raw `var(--popover)` resolves to nothing at all — no error, just an unstyled
    element. `--radius` is declared for real, in both density blocks, precisely because copied
    components read it that way.

45. **The URL shape is `/p/$panelSlug/...` with an orthogonal `?org=<slug>`.** CONSOLE_FLOW §4
    states the rule and says "the URL's shape is phase 7's", so this is that decision: the org is
    a SEARCH param because it re-scopes whatever screen you are on rather than naming a different
    one, which means one `validateSearch` on the root route covers the tree. The URL carries the
    slug, the wire carries the id, and no extra round trip is bought — `GET /internal/me` already
    returns `memberships` with both, from the join Deviation 2 added. Full reasoning in
    `components/shell/context.ts` and the decisions log.

46. **`ACTIVE_ORG_HEADER` moved to `@labelloop/contracts`.** Not in the plan. `session.ts`'s own
    comment said "three places must agree on the spelling and only one of them can be wrong
    silently"; the console is a fourth, and it CANNOT import from `apps/api/src/middleware` —
    that module pulls better-auth and a `pg.Pool` into a browser bundle. Hard-coding the string
    in `apps/web` would have recreated exactly the drift the comment warns about. `session.ts`
    re-exports it so its existing readers are unchanged.

47. **The trace table is still ORG-WIDE inside a panel's Traces section, and the screen says so.**
    `GET /internal/traces` takes no panel filter, and CONSOLE_FLOW §3 gives phase 8 the job of
    scoping it. The plan's phase 7 asks for the screen to be re-skinned and moved inside the
    shell, which is what proves the conversion on real data — so the table is where the mockup
    puts it, with a dashed notice naming the gap and phase 8.

    Considered and rejected: filtering client-side by `panel_id`, which silently drops rows the
    50-row page did not contain; and leaving it unlabelled, which is the console showing an org's
    rows under a panel's heading and asserting something untrue. The notice is drawn in the same
    dashed language as an unbuilt screen so it reads as scaffolding, and it goes away with the
    org-wide read.

48. **The typecheck caught a hand-written role union that was missing a role.** The first draft of
    `context.ts` wrote `'admin' | 'engineer' | 'annotator'`; the schema has a FOURTH,
    `guest_expert` — PRODUCT.md 5.1's invited SME. The union is now DERIVED from what
    `GET /internal/me` returns, which is the rule `queries.ts` already states for response shapes.

    The bug it would have caused is not cosmetic: the shell decides who sees a console from that
    value. It is now an ALLOW list (`isStaffRole`), so a role added to the schema defaults to
    seeing nothing until someone decides otherwise — the opposite default hands a console to
    whoever is added next. This is the internal surface's stated guarantee working as designed,
    the same way Deviation 6 described.

49. **Three lint findings in copied components were FIXED rather than suppressed, and one removed
    behaviour.** `sidebar.tsx` writes a `sidebar_state` cookie to remember a collapsed rail. It is
    unreachable here — the rail is `collapsible="none"` and nothing renders a trigger — and a
    cookie remembering view state is the shape ADR-0047 rejected for the org, so it was deleted
    with a note rather than silenced with a rule override. Two `useExhaustiveDependencies`
    findings were real (`setOpenMobile` is a `useState` setter, so it can never change).

    No `biome.json` override for `components/ui/**` was added, deliberately: silencing lint on
    copied code is how a real bug hides in it, and ADR-0046 is explicit that these components are
    ours to maintain. The cost is that a future `shadcn add` may need the same three fixes again.

50. **`shadcn` no longer generates `lib/utils.ts`; it installs `cn`.** Checked rather than
    assumed, since an unfamiliar one-word package name is worth a look: it is shadcn-ui's own
    (`github.com/shadcn-ui/cn`), MIT, zero runtime dependencies, and it replaces the classic
    `clsx` + `tailwind-merge` pair. Two dependencies down to one.

51. **`.claude/launch.json` is added, so the console can be previewed without remembering a
    command.** Not in the plan, and added because the first thing that happens after a phase that
    changes how everything LOOKS is someone wanting to look at it. One entry, `bun run --cwd
    apps/web dev` on port 5173 — the port `vite.config.ts` already pins with `strictPort`,
    because the API's `WEB_ORIGIN` and better-auth's trusted origin both name it.

    The console needs the API for anything past the sign-in screen: `set -a && . ./.env && set
    +a` then `docker compose -f infra/docker-compose.yml up -d` (compose's project directory is
    `infra/`, so the repo-root `.env` is NOT read — Deviation 12). Seeded sign-in is
    `demo@labelloop.test` / `localdev-password`, both local fixtures from `scripts/seed.ts`.

52. **The bundle grew from 437 kB to 626 kB (139 kB to 201 kB gzipped).** Named rather than
    discovered later: that is Tailwind's output plus Radix, lucide and Sonner, and it is ~45%
    more over the wire on the console's first load. Vite's 500 kB chunk warning now fires. Not
    addressed here — code-splitting the console is a change to how it loads, not to how it looks,
    and phase 7's job was the frame. Worth revisiting once phase 8's screens are in and the real
    number is known.

53. **THREE BUGS FOUND BY DRIVING THE RUNNING CONSOLE, none of which any check in this phase
    would have caught.** Recorded together because they share a cause: every automated gate here
    — typecheck, lint, tests, build, even the computed-style probe against the built stylesheet —
    verifies the console in PIECES. All three only exist once it is assembled and clicked through.

    (a) **Every portalled overlay rendered LIGHT on the dark console.** Radix — and so every
    shadcn overlay: both switchers' menus, the Dialog the key reveal and revoke confirmation will
    use, the Sheet, tooltips, Sonner — renders into `document.body`, OUTSIDE the element carrying
    `data-surface="console"`. The approved tokens resolve tone by ANCESTRY, so a portalled menu
    reads every token from the `:root` default, which is light. Confirmed rather than guessed:
    the open menu's `--color-surface` computed to `#FFFFFF` where the shell's was `#161A21`.

    No error anywhere — the tokens are all defined and simply read from the wrong scope. Fixed
    with `useSurface`, which mirrors the preset onto the document element for as long as a
    surface is mounted, in a layout effect so there is no light first frame. **The 6b mockup
    could not have surfaced this**: its menus are `details` elements that never leave the tree.

    (b) **The section nav stopped highlighting on the URL most people arrive by.** TanStack's
    `Link` matches search params by DEFAULT (`activeOptions.includeSearch`), every nav link
    carries `?org=`, and the URL you land on after signing in does not — so at `/p/some-panel`
    nothing was marked current, while `/p/some-panel?org=demo` was. `includeSearch: false`.

    (c) **The "link isn't available" state replaced the whole page instead of rendering inside
    the shell.** The approved 6b screen puts it in the stage with the sidebar intact, and
    CONSOLE_FLOW §6 makes "the sidebar stays usable" surface 2's DEFINING property. Worse, it
    undercut its own message: the state exists to say *nothing has been switched*, which the
    console can DEMONSTRATE by still showing that org at the foot, and a bare page cannot.
    `ConsoleContext`'s `not-a-member` now carries the fallback org so the shell renders around it.

    **The lesson worth keeping for phase 8**, since it builds three screens on this frame: the
    phase's automated verification was green and its manual verification had not started, and
    that gap is exactly where these lived. A token conversion can be proved with a probe; a
    SHELL cannot.

54. **The panel switcher kept the focus ring after a plain click, and sat 4px from the nav.**
    Stakeholder, looking at the running console: the switcher had "a white border around it that
    needs to go", and Overview needed "more breathing room".

    Both are one collision. The border is the approved `--shadow-focus` — 4px of
    `--graphite-paper` drawn OUTSIDE the element — and it was showing because **Radix returns
    focus to the trigger programmatically when a menu closes, which Chrome treats as
    keyboard-ish, so `:focus-visible` matches after a mouse click.** Measured on a
    `data-state="closed"` trigger: `matches(':focus-visible')` true, the full ring present. The
    gap below it was `--gap-tight`, 4px at compact — exactly the ring's width, so they touched.

    **Neither half was fixed by deleting the ring.** It is the approved focus treatment and it is
    how a keyboard user knows where they are; removing it to fix a mouse-only artifact trades an
    accessibility affordance for a cosmetic one. `useMenuFocusReturn` records whether the menu
    was opened by POINTER and, if so, prevents Radix's focus return — so a mouse user gets no
    stuck ring and a keyboard user still lands back on the trigger, ringed. Verified both paths:
    pointer → `focus-visible` false and no shadow; keyboard → focus returned, ring present.

    The gap became `--gap-stack`. The approved mockup's 4px was drawn when the switcher was a
    `details` element with no ring, so this is not a departure from the approved screen so much
    as the first time that spacing met a focusable control. **Worth noting for phase 8**: the
    same helper belongs on any menu it adds.

### Phase 8

Phase 8 is landing as TWO PRs, split at the seam that already existed: the API first (#69,
merged), the console second. The phase stays one unit here; only the review was split, because
one PR would have been very large for a repository meant to be read.

55. **Neither requirement the API half removed was under test** — no test asserted the judgeless
    refusal in `evaluate`, and none asserted `judges: min(1)` on create. Both could be deleted with
    the suite staying green. It is the pattern of Deviations 17, 22 and 29 again, and it suggests
    the gap is not random: **the rules that say "no" are the ones that go untested**, because the
    happy path is written first and a refusal only surfaces when someone hits it. The new tests
    target exactly that — a collecting panel reaches no provider, proved by a provider that FAILS
    the test if touched rather than by counting calls.

56. **`state: 'collecting' | 'judged'`, with `passed`/`score` null — not false.** ADR-0060
    deferred the field names to this phase. A gate told `false` blocks everything; told `true` it
    ships everything believing it is protected. `complete` stays true, vacuously.

57. **The approved snippet predated the contract this phase shipped.** 6c's starter code told
    callers to read `data.passed`, which is null while a panel collects. Every snippet now reads
    `state` first. Deviation 40 said the snippet was "written against the contract"; the contract
    moved underneath it in the same phase.

58. **The frame was rebuilt: a top bar and a panel-only sidebar (ADR-0062).** Superseding the 6b
    review's decisions 1 and 2, two days after they were approved, because rendering against a real
    org left the rail at Home about nine-tenths empty. Create panel went page → dialog in the same
    review. **Built directly rather than mocked first**, on the stakeholder's call — recorded in the
    ADR so it is a decision rather than a lapse.

59. **The console's SPACING was opened in `tokens.css`; its TYPE was not.** The first attempt at
    "make it breathe" switched the console to the comfortable density, which moved body text from
    13px to 17px and read as everything simply getting bigger. The fix edited the approved file's
    compact block (console-only — comfortable is the annotator's): gap-stack 12→16, gap-section
    24→32, panel padding 16→20/24, cell padding 6/8→8/12, row-min 30→32, and a new `--pad-bar-*`
    for the bar. The same pass found spacing that was wrong independently of density: panel rows
    8px apart carrying 28px of padding inside, stage sections a stack-gap apart when
    `--gap-section` existed for exactly that and went unused, and a bar padded by a hard-coded
    `--space-2` that ignored the axis entirely. Edited in `mockups/` first and copied; the ADR-0046
    diff still reports zero lines lost.

60. **A correlated subquery compiled to `traces.panel_id = traces.id` and answered 0 for every
    panel.** Drizzle renders a column inside a `sql` template UNQUALIFIED, and inside a subquery an
    unqualified name binds to the inner table whenever it exists there. The judge count beside it was
    correct by luck — `panel_version_judges` has no `current_version_id` for its outer reference to
    be captured by. Found because a card read 0 beside a database holding 4332; no type or error
    could have shown it. Both are qualified now, and a test asserting real counts was
    mutation-checked: reverting the qualification fails it.

61. **The API in Docker was four days stale.** The first create from the console returned 422 —
    `judges: expected array` — against source where judges were optional; the image was built
    2026-09-13. The test suite ran against source and the browser against the container, so the two
    were testing different code. Local development now runs the API from source (`bun run --cwd
    apps/api dev`), and this is worth knowing before trusting any browser check against compose.

62. **The one-time key is memory-only, and a key issued from Keys now feeds the snippet.** The
    plaintext exists exactly once; it is held per-tab in `issued-key.ts` — never storage, never a
    URL — and lost on reload, which is its correct lifetime. A panel whose creation reveal is behind
    you shows `YOUR_KEY`, and "show the last four" cannot help: `last4` is stored, the other sixty
    characters are not recoverable from a hash. So issuing a key from Keys, the one other moment a
    plaintext exists, now makes the Overview snippet runnable — masked on screen, real on the
    clipboard. The first draft masked the key row and put the plaintext in the code block; masking
    one and not the other protected nothing.

63. **The trace table went nine columns → six by merging, not deleting.** Adding the panel and key
    NAMES (a server-side join; `key_name` is null when a key is deleted, since a trace outlives its
    credential) made every cell wrap four lines deep — the harvest's Q1, *ten columns will not fit a
    laptop*, arriving on schedule. Score and threshold became one cell (`1.00 / 0.50`), Recorded
    folded into Created as a `pending` mark, and nothing reflows. **Sort and filter by key were asked
    for and are unscheduled** — the trace explorer has no milestone, and open question 2 is still the
    place to decide it.

64. **`relations.test.ts` now has TWO failures against a local database, both seed-state.** Both read
    `[0]` from shared tables with no ordering; panels created while driving the console now sort
    first. CI builds a fresh database and is unaffected. The queued task for the member-count test
    should cover this one too — same file, same cause.

65. **The Overview changes mode at the first trace, and the snippet moves to Keys.** Raised by
    the stakeholder while driving the M4 flow: after one call, the page still said *"Send your
    first call"*, which was no longer true. The switch is DATA-driven (`trace_count > 0`), not a
    dismiss button, and happens at ONE trace rather than at the 50-trace gate — the snippet's
    job is done once a call works (stakeholder, 2026-09-18). Its place goes to Recent traces
    (five, the same table component as Traces, with View all), and the snippet becomes *"Call
    this panel"* on Keys, where a key and an endpoint are what the reader is holding. The gate
    card lost its headline, a duplicate COLLECTING mark and two paragraphs; the integrator's
    note about `state: "collecting"` moved beside the code it concerns. The Overview re-reads
    every 5s while collecting, so the count visibly climbs — the demo's own line.

66. **`GET /internal/traces` REQUIRES `panel_id`, rather than accepting it.** Traces is a section
    inside a panel (ADR-0062), so no screen asks for an org's traces, and an optional filter
    keeps alive a read nothing uses and every future caller could forget to narrow. Relaxing it
    later is cheap. Another org's panel id answers an empty list — the org filter still applies,
    and empty is what a real panel with no traffic says too, so it confirms nothing. The
    sibling-panel test was mutation-checked: dropping the panel condition fails two tests.

67. **TanStack Router merges a validator's result OVER the raw query string**, so a key the
    validator omits keeps its unvalidated value. The first redirect check was therefore a no-op
    — `?redirect=//evil.example/x` survived validation and only the router's own href
    normalisation kept the result on-origin. The same bug had sat in phase 7's
    `validateConsoleSearch`: `?org=` drew the not-a-member state its own comment said it
    prevented. Every validator now returns every key, `undefined` when absent; tests assert the
    key is PRESENT, since an omitted key passes `toBeUndefined`. `safeRedirect` runs again at
    the point of use.

68. **The first signed-out redirect hung the tab.** `<Navigate>` re-navigates whenever its props
    object changes, and `search={{ redirect: location.href }}` is new on every render while
    each navigation re-renders the layout. Replaced with `router.invalidate()` in an effect
    keyed on a boolean, which re-runs the route's own `beforeLoad` — one place builds the
    redirect. Sign-out clears the cache BEFORE navigating: `/login`'s `beforeLoad` would
    otherwise find the old session cached and bounce straight back.

69. **Login asks which doors exist; it draws BOTH conditionally, not only GitHub.**
    `GET /internal/sign-in-methods` is public, registered before the guard but kept at the head
    of the typed chain, and reads better-auth's built options rather than recomputing them from
    config. The plan named only the GitHub button; the password form had the mirror-image
    problem — drawn in production, where ADR-0049 disables it.

    **Also found: `bun --hot` does not pick up route changes.** The API ran from source, as
    Deviation 61 prescribes, and still served the old trace route and 401'd the new public one
    until restarted. Running from source is necessary, not sufficient: restart it after a
    route change.

70. **Role-adaptive meant three gaps, not a new surface.** The shell already hid the console
    from non-staff roles. What the UI still offered past the server: the `?new` dialog mounted
    for any role (a form that could only end in FORBIDDEN), the panel list was requested for
    roles the server refuses, and Organisation settings (M8) showed to every role though
    ADR-0062 calls it admin-only. The org switcher also still opened UPWARD from the top bar
    ADR-0062 moved it to — working only because Radix flips a colliding menu. `GET
    /internal/traces` remains unguarded by role (Deviation 32), and the UI is stricter than the
    server there by showing an annotator nothing.

71. **The empty Home and the create dialog were redesigned at review, three rounds for the
    dialog.** Home's empty state became a centred screen that draws the loop (the decision node
    dashed, because a new panel only collects) with one action. The dialog went from an essay
    (three-sentence description, mono hints 4px under their inputs, 46rem) to one sentence,
    muted sans hints, 8px within a field and 24px between, 34rem with 32px edges. A muted
    footer band was tried and REJECTED: on a dark surface a lighter fill reads as a raised
    slab. All dialogs' overlays now blur as well as dim. No token was changed.

72. **"Member of nothing" became org creation, which is how FORBIDDEN was settled (ADR-0063).**
    Asked what FORBIDDEN should mean, the stakeholder asked instead why a member of nothing is
    refused at all rather than offered an organisation. Following that showed the plan's own
    demo could not run for a new person: *"sign in with GitHub → create a panel"* dead-ended at
    the first step for any account not already in an org, and the manual verification only ever
    passed against the seeded `demo` org or a hand-inserted membership. So the phase grew a write
    path it did not plan: `POST /internal/orgs` (member of nothing only; creator becomes admin;
    `org.created` audited; one transaction), `sessionAuth` split into `accountAuth` + org
    resolution, and `/me` answering an empty membership list with 200 instead of 403. FORBIDDEN
    keeps one meaning — wrong role — and any FORBIDDEN re-asks `/me`. The guard against a member
    creating a second org was mutation-checked. The old no-org screen also had no way to sign
    out; the new one does.

73. **Names and slugs got one set of rules, shared by the server and a live checklist.** Asked
    whether anything stopped special characters, the audit found slugs already strict but names
    accepting ANY Unicode — control characters (a newline breaks a table row, ESC rewrites a log
    reader's terminal), bidi overrides ("Trojan Source": a key name that displays as `prod-key`
    and is not) and zero-width characters. `@labelloop/contracts` `names.ts` now owns the rules;
    the API validates org, panel, key and judge names with `displayNameSchema` (NFC-normalised,
    any script and emoji allowed, ZWJ kept for emoji sequences) and slugs with `slugSchema`,
    returning each broken rule's own label as the field issue; the console renders the SAME list
    as a ✓/✕ checklist (stakeholder's request), shown while the field has focus or a rule is
    broken. A test asserts the slug rules together equal the old regex exactly.

    Three things surfaced doing it. **The create dialog's slug regex had drifted** — it allowed a
    leading digit the server refused; the rules being shared is what closes that class. **A hyphen
    could not be typed into a slug**: the field re-ran `slugify` per keystroke, stripping the
    trailing hyphen as it was typed; hand-typed slugs are now only lowercased and de-spaced, and
    the checklist says the rest. **The Write tool decoded `\uXXXX` escapes into literal
    characters**, so `names.ts` briefly held a real RIGHT-TO-LEFT OVERRIDE inside a comment —
    the attack this rule exists to refuse, in its own source. Caught by reading the diff; every
    such character is now an escape, and a scan found no others in the touched files.

    **And the first checklist made the submit button unclickable.** It collapsed when focus left
    a valid field — so pressing Create blurred the name, the list folded, the vertically-centred
    form shifted ~26px, and the click landed where the button had been. The stakeholder reported
    it as "the button is always disabled"; the DOM said enabled. The checklist now stays once a
    field has content, and nothing moves at the moment of a click.

---

## Open questions for the human
Two of the original four were answered by the stakeholder on 2026-09-11 and are now decisions
16 and 17. The remaining two are review-time calls inside the phases they affect, and cost
nothing to carry:

1. **ANSWERED at the 6b review, 2026-09-14 (stakeholder): greyed out, labelled with the milestone
   that builds it** — "keeps us honest, and lets us point back to things as we get further in".
   Original question, kept: **What does the sidebar do when a section is inert — hide it, or show it disabled?** The
   plan says visible-but-inert, on the argument that it makes the app's direction legible. The
   counter-argument is that a console full of dead links reads as unfinished in a demo, which
   is the one context this project is optimised for. Decide at the 6b review.
2. **Does the trace table get the harvest's design decisions applied** (judge and human as
   separate columns, agreement derived, raw payloads expanding rather than inline), or does it
   stay a plain table until M5? The harvest's `console-trace-explorer` notes are usable but
   reference the retired `cls_` vocabulary, and its Q1 — ten columns will not fit a laptop
   viewport — is unresolved. Decide in phase 8.
3. **Should the wizard help authors write judges that GATE rather than WORK — and if so, how?**
   *(Added 2026-09-14 from a conversation during phase 5 verification. Decide at the 6c review.)*

   ADR-0036 makes a judge valid only if it clears two bars: it is expressible (polarity), and it
   **evaluates something the caller's system produced rather than producing a fact that system
   needs**. Postgres enforces the first. **Nothing in the schema can enforce the second** — the
   ADR says so — which leaves the phase 6c wizard as the only author-facing surface there is.
   As planned it collects question, polarity, weight and `required`, and nothing about bar 2.

   **The hazard is demonstrated, not hypothetical.** While verifying phase 5, the implementer
   built a judge `is-p0` — *"Does this issue describe a production outage?"* — and evaluated it
   against a raw incident with no `context`. That is the classification shape ADR-0036 forbids:
   with no agent output anywhere in the request, the judge can only do the labelling itself,
   and an expert reviewing it has nothing of an agent's to agree or disagree with. If the
   implementer wrote one while testing the product, a customer will.

   What the conversation established, in the terms a wizard would need:
   - **The sorting question is "where in this request is the agent's work?"** If the answer is
     nowhere, the judge is doing work.
   - **A GENERATING agent's work goes in `artifact`** — an image, a drafted reply — with the
     spec it worked to in `context`. **A DECIDING agent's work goes in `context`** — a severity
     label, a routing choice — with the input it decided about as the `artifact`, and the judge
     asks whether that decision is wrong (ADR-0037's `mis-routed`). Real agents often do both.
   - `context` is a flat string-to-string map today, so an agent's nested output is flattened
     by the caller.

   Options, NOT decided:
   - **(a) Nothing in the UI.** Bar 2 stays the author's responsibility, as ADR-0036 currently
     reads. Cheapest, and it relies on people reading an ADR.
   - **(b) Explanatory copy** beside the question field: gate versus work, and the `context`
     move, with one generating and one deciding example.
   - **(c) A structural prompt.** Ask up front whether the agent being judged *makes something*
     or *decides something*, and frame the question field and the declared context keys from
     the answer. Strongest nudge; also the most product surface to draw.
   - **(d) A heuristic warning** — for instance, a question shaped like a classification with
     no context keys declared. Likely to misfire, and a warning people learn to click past.

   **Why this is flagged rather than drawn:** Phase A was paused because four mockups made six
   product decisions ahead of PRODUCT.md (ADR-0055). Whatever 6c draws here IS a decision, so it
   should be made at the review, on purpose, and recorded — not arrive as a layout.
