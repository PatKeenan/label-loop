# STACK_DECISIONS.md — technology choices (stakeholder-owned)

REGISTER LOCKED 2026-08-19 (D13 added 2026-08-20). Docs and ADRs stay implementation-agnostic until a row here is DECIDED. Each decision,
once made, gets a short ADR recording the why. Options listed are starting points, not
a menu limit.

| # | Layer | Options considered | Decision | ADR |
|---|-------|----------------|----------|-----|
| D1 | API language + framework | — | **DECIDED: Bun + Hono + TypeScript.** Public `/v1` = versioned REST via OpenAPIHono (Zod-driven spec); internal console surface = Hono RPC. | 0004 |
| D2 | Web framework (console + annotator) | — | **DECIDED: React SPA on Vite + TanStack Router + TanStack Query.** No SSR framework. | 0005 |
| D3 | Database + migrations | — | **DECIDED: Postgres + Drizzle**, forward-only migrations. | 0006 |
| D4 | Async queue | — | **DECIDED: pg-boss (Postgres-backed). No Redis until the k6 breaking-point doc proves the need.** | 0006 |
| D5 | Integration surface | — | **DECIDED: no SDK.** OpenAPI spec + Scalar docs at `/docs` + fetch/curl snippets. | 0002 |
| D6 | Observability stack | — | **DECIDED: OpenTelemetry (manual instrumentation via Hono middleware + the `llm/` module) → self-hosted Grafana stack in containers; Sentry (free tier) for error reporting.** | 0007 |
| D7 | Inference server | — | **DECIDED: vLLM** (multi-LoRA dynamic adapter serving). | 0006 |
| D8 | Fine-tune training | — | **DECIDED: Axolotl on rented GPU; training YAML configs live in the repo.** | 0006 |
| D9 | Auth implementation | — | **DECIDED: better-auth** (self-hosted, TS-native, OIDC social login + API-key support). Hosted providers would hide the auth work being showcased. | 0008 |
| D10 | Deploy target | — | **DECIDED: containers-first. Railway now; AWS as documented escape hatch. GPU serving (M7) on a GPU host as a separate service.** | 0009 |
| D11 | Monorepo tooling | — | **DECIDED: Bun workspaces** (replaces pnpm, tsx, and the test runner). | 0004 |
| D12 | CI platform | — | **DECIDED: GitHub Actions.** | — |
| D13 | Release automation | semantic-release, changesets, manual `gh release` | **DECIDED: release-please.** Version + CHANGELOG derived from conventional commits; a standing Release PR is the ship gesture. No hand-written version numbers. | 0011 |

Decided-by-stakeholder already (not open):
- Load testing: **k6** (explicit requirement)
- Payments: **Stripe** metered billing (explicit requirement)
- Fine-tuning method: **LoRA/QLoRA** on a small open-weights model
- Auth protocol: **OIDC/OAuth** + scoped API keys (protocol-level, implementation is D9)
