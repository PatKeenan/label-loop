---
date: 2026-09-11T18:40:00Z
author: claude-code
status: draft
milestone: M4
topic: m4-console-auth
related_adrs: [0003, 0008, 0009, 0014, 0016, 0019, 0020, 0022, 0023, 0025, 0026, 0034, 0035, 0046]
---

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
  first membership when absent. `AuthenticatedSession` gains `memberships` so the console can
  render a switcher without a second round trip.
- `apps/api/src/middleware/require-role.ts` — **new.** `requireRole('admin', 'engineer')`,
  composed AFTER `sessionAuth()`, reading `c.var.session.role` — which is now the role for the
  active org. Throws `FORBIDDEN` with a message that does not enumerate what the caller lacks.
- `apps/api/src/routes/internal/index.ts` — no structural change; the guard stays the thing
  every later route is registered behind.
- `apps/api/src/routes/internal/me.ts` — return `memberships[]` alongside the active org.
- `apps/api/src/middleware/session.test.ts`, `require-role.test.ts` — new/extended.

### Steps
- [ ] `listMemberships` + org-scoped `findMembership`, with the ordering rule preserved
- [ ] `sessionAuth` resolves and validates the active org; unknown or non-member org is refused
- [ ] `requireRole()` middleware, with `FORBIDDEN` and a non-enumerating message
- [ ] `GET /internal/me` returns active org, role, and the membership list
- [ ] Negative tests: a member of org A asking for org B is refused; an annotator hitting an
      admin-guarded route gets `FORBIDDEN`; a request with no header still works
- [ ] The existing "an API key gets nowhere near the console" assertion still passes untouched

### Automated verification
- [ ] `bun test apps/api/src/middleware/` passes
- [ ] `bun test apps/api/src/routes/internal/` passes
- [ ] `bun run typecheck` and `bun run lint` clean

### Manual verification
- [ ] Sign in locally; `GET /internal/me` shows the seeded org, `admin`, one membership
- [ ] Hand-craft a request with another org's id in the header; confirm it is refused and
      that the refusal does not reveal whether that org exists

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
- [ ] Config vars + production `superRefine` rule with a message naming the field
- [ ] GitHub provider registered conditionally; absent creds leave a working local build
- [ ] `emailAndPassword` disabled in production only
- [ ] `.env.example` updated
- [ ] Tests for all three environment shapes

### Automated verification
- [ ] `bun test apps/api/src/config.test.ts apps/api/src/auth.test.ts` passes
- [ ] `bun run typecheck` clean

### Manual verification
- [ ] A fresh clone with **no** `.env` still boots and signs in with the seeded password
      account (ADR-0009 — this is the property most at risk in this phase)
- [ ] With a real GitHub OAuth app (localhost callback), the GitHub button completes a
      sign-in and lands on "not a member of any organisation" for a new account — the
      expected M4 behaviour, and the M8 gap named in the research

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

### Steps
- [ ] `recordAuditEvent` with `actor_type='user'`, `actor_id` from session, `request_id` bound
- [ ] Key minting: prefix + 32 random bytes, SHA-256 stored, `last4` kept, plaintext returned once
- [ ] List and revoke, both org-scoped from the session and never from a request parameter
- [ ] Revocation is a status flip; the row survives, and a revoked key still resolves in the
      hot-path read (which is deliberate — see `api-keys.ts`)
- [ ] `api_key.issued` and `api_key.revoked` written
- [ ] Tests: plaintext appears exactly once and is not in any later response; a revoked key is
      refused at `/v1`; another org's key is neither listed nor revocable
- [ ] Test: the audit rows land and the app role still cannot UPDATE or DELETE them

### Automated verification
- [ ] `bun test apps/api/src/routes/internal/keys.test.ts apps/api/src/services/` passes
- [ ] `bun test packages/db/src/audit-events.test.ts` still passes (grant unchanged)
- [ ] `bun run typecheck`, `bun run lint` clean

### Manual verification
- [ ] Issue a key in the API, copy the plaintext, call `POST /v1/panels/{id}/evaluate` with it
- [ ] Revoke it; the same call now fails with `UNAUTHORIZED`
- [ ] `SELECT * FROM audit_events` shows both events with a `request_id` that matches the
      response envelope

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
  advertised structured output with 3 of its 9 endpoints unable to do it — and
  `claude-haiku-4.5` advertises it and still broke the output contract 4 times out of 4.
  The catalogue POPULATES; `validatePin` GATES.
- Warn "this model always reasons" from `reasoning.mandatory`. That would be false for
  `gemini-3.5-flash-lite`, which is `mandatory: true` and reported **0 reasoning tokens** at
  `minimal` across three runs — the cheapest and fastest model measured.
- Present cross-lab tiers as equivalent. There is no `gpt-5.6-mini`; the nearest peer is a
  generation behind.

### Steps
- [ ] Catalogue client with TTL cache, last-good-snapshot fallback, injected `fetch`
- [ ] `GET /internal/models` returns price, endpoint count, supported efforts, mandatory flag
- [ ] `POST /internal/judges/validate-pin` surfaces `reason` verbatim, never as an error envelope
- [ ] Tests: a failing refresh serves the previous snapshot and logs at `warn`; a cold start
      with no network returns an explicit empty-with-reason rather than a silent empty list
- [ ] `architecture.test.ts` still passes with the new outbound call inside `src/llm/`

### Automated verification
- [ ] `bun test apps/api/src/llm/catalogue.test.ts` passes
- [ ] `bun test apps/api/src/architecture.test.ts` passes
- [ ] `bun run typecheck`, `bun run lint` clean

### Manual verification
- [ ] With a real `OPENROUTER_API_KEY`, `GET /internal/models` returns a populated list whose
      numbers match the measurement table for the six models already measured
- [ ] Validate a pin for `anthropic/claude-haiku-4.5` and confirm the failure reason says the
      rationale exceeded its length — actionable, not "invalid output"

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
- [ ] Repository writes for all five tables plus activation
- [ ] `createPanel` service: one transaction, validate every `llm` pin before insert
- [ ] `model_pin_validation` written from the validating call (`available_endpoints`, `served_by`)
- [ ] Routes, org-scoped from the session, role-guarded
- [ ] `panel_version.created` / `judge_version.created` audit rows
- [ ] Tests: a rejected pin creates NO rows (transaction rolls back); weight 0 and missing
      polarity are refused by the database, not only by the schema; the created panel answers
      `POST /v1/panels/{id}/evaluate` with a key from phase 3

### Automated verification
- [ ] `bun test apps/api/src/services/create-panel.test.ts` passes
- [ ] `bun test apps/api/src/routes/internal/panels.test.ts` passes
- [ ] `bun run typecheck`, `bun run lint` clean

### Manual verification
- [ ] Create a panel with one `fake:` judge and one real `openrouter:` judge; confirm both
      froze with a populated `model_pin_validation`
- [ ] Attempt a judge on `claude-haiku-4.5`; confirm nothing is written and the reason is legible
- [ ] Evaluate against the new panel with a key issued in phase 3 — **end to end with no seed**

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

- [ ] Every console screen named, with its milestone and its entry point
- [ ] Screens that do not exist yet marked as such, so the map is a plan rather than a claim
- [ ] Referenced from `mockups/BRIEF.md`

### 6b — `mockups/console-shell.html`
The frame, reviewed on its own terms. **Navigation is a persistent left SIDEBAR** (stakeholder
decision, 2026-09-11), which re-confirms the harvest's orphaned decision rather than replacing it.

- [ ] Sidebar: section nav, populated from the flow map
- [ ] **Org switcher** — reads the membership list phase 1 returns from `/internal/me`
- [ ] **Panel switcher** — the harvest's "classifier switcher" in current vocabulary (ADR-0019)
- [ ] Signed-in identity and role indicator, and the way out
- [ ] Where a modal appears (the one-time key reveal needs one) and where errors surface
- [ ] Sections M4 does not build are drawn **visible but inert**, so the shell is honest about
      where the app is going without committing to those screens' contents
- [ ] `data-surface="console"`, plain HTML + CSS on `tokens.css`, header comment per the BRIEF

### 6c — `mockups/panel-create.html`
The wizard, drawn INSIDE the approved shell.

- [ ] Panel details → judges (question, polarity, weight, `required`) → model picker → review
- [ ] Model picker shows cost, measured latency **and its spread**, and the endpoint count
      surviving the pin. A median would have hidden `flash-lite` at 847–972 ms against
      `haiku` at 3078–15092 ms — the spread is the number that matters to a caller
- [ ] The effort dial's per-model cost and latency consequence (one model's own range spanned
      1.8x cost and 1.7x latency, and two of its efforts were indistinguishable)
- [ ] Where quantization is offerable, what constraining it **costs in failover** — 13
      endpoints down to 6, most of the loss being endpoints that never declared a precision
- [ ] The unsatisfiable-pin form error, carrying a real reason string
- [ ] The one-time key reveal, and that it cannot be shown again
- [ ] Realistic data drawn from the measurement table — no lorem ipsum (BRIEF rule)

### Also
- [ ] `mockups/BRIEF.md` records the partial resume, the sidebar decision, and the three artifacts

### Automated verification
- [ ] `bun run lint` clean (static files; this is a formatting check)

### Manual verification
- [ ] **Human review and approval of the flow map, then the shell, then the wizard — in that
      order.** This is the gate: Phase C rebuilds from approved screens, so phases 7 and 8 are
      blocked until the shell in particular is signed off, because phase 7 BUILDS it.

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
- [ ] Tailwind + shadcn configured; build produces a working bundle
- [ ] Token conversion complete, with a comment naming ADR-0046 and the alias rule
- [ ] Every value in the approved palette still reachable — nothing dropped in translation
- [ ] Sidebar shell built to the approved 6b screen, with inert sections rendered as such
- [ ] Org switcher sends the active org header phase 1 validates; switching re-scopes the view
- [ ] Existing screens re-skinned inside the shell; behaviour unchanged
- [ ] `apps/web/nginx.conf` still serves the bundle correctly (ADR-0020: SPA fallback, a real
      404 for a missing fingerprinted asset, `immutable` on `/assets/`, `no-store` on the shell)

### Automated verification
- [ ] `bun run --cwd apps/web build` succeeds
- [ ] `bun test apps/web` passes (the error-map exhaustiveness test especially)
- [ ] `bun run typecheck`, `bun run lint` clean
- [ ] `bun audit --audit-level=high` clean — Tailwind and shadcn's tree are new surface, and
      CI fails a PR on any high advisory

### Manual verification
- [ ] The shell renders in both tones and both surfaces, matching `tokens-preview.html`
- [ ] Diff the converted tokens against the approved `mockups/tokens.css` and confirm by eye
      that no approved value was lost — the check ADR-0046 exists to make possible
- [ ] Switching org in the sidebar changes what the trace table shows, and cannot reach an org
      the signed-in account is not a member of

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
- [ ] All three screens mount inside the phase 7 shell; none invents its own layout
- [ ] Keys screen: issue with one-time reveal, list with `last4`, revoke with confirmation
- [ ] Wizard: panel details → judges (question, polarity, weight, required) → model picker →
      review → create
- [ ] Model picker shows cost, latency AND spread, endpoint count, effort consequences
- [ ] Unsatisfiable pin is a form error beside the field, carrying the real reason
- [ ] Trace table extended with the panel and judge context now available
- [ ] Redirect-after-401 via `beforeLoad`
- [ ] Role-adaptive: an annotator does not see engineer-only surfaces (the UI mirrors the
      server guard; it never replaces it — CONVENTIONS "Keys & auth")

### Automated verification
- [ ] `bun test apps/web` passes
- [ ] `bun run --cwd apps/web build` succeeds
- [ ] `bun run typecheck`, `bun run lint` clean
- [ ] `bun test` (full suite) green

### Manual verification
- [ ] **The full interviewer flow, on a database with no seeded panel:** sign in with GitHub →
      create a panel and judges through the wizard → issue a key → curl
      `POST /v1/panels/{id}/evaluate` → watch the trace appear in the table. This is M4's
      demo moment and the definition of done for the milestone.
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
- **No BREAKING_POINT v1 rerun.** M4 makes the saturation number *measurable*; producing it is
  separate work. The k6 key-minting path is named as an open question below rather than built.
- **Phase A stays paused** for `annotator-session` and `console-dashboard`, and the six
  harvest blockers stay open.

## Open questions for the human
1. **How does k6 mint N keys?** BREAKING_POINT §8 ranks this first, and management is
   console-only — so the path is either the internal RPC driven with a session cookie, or an
   ops script. Naming it here would let phase 3 leave the right seam; leaving it unnamed risks
   discovering at v1 time that the door was never built. Should phase 3 ship that seam?
2. **Does the header-based active org need a `403` or a `404` for a non-member org?** `404`
   leaks less (it does not confirm the org exists); `403` is more honest to a user who really
   is a member of something else. The API-key path chose the non-confirming answer for exactly
   this reason, which argues for `404`.
3. **What does the sidebar do when a section is inert — hide it, or show it disabled?** The
   plan says visible-but-inert, on the argument that it makes the app's direction legible. The
   counter-argument is that a console full of dead links reads as unfinished in a demo, which
   is the one context this project is optimised for. Worth a look at the 6b screen.
4. **Does the trace table get the harvest's design decisions applied** (judge and human as
   separate columns, agreement derived, raw payloads expanding rather than inline), or does it
   stay a plain table until M5? The harvest's `console-trace-explorer` notes are usable but
   reference the retired `cls_` vocabulary and its Q1 (ten columns will not fit a laptop)
   is unresolved.
