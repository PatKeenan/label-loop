# ADR-0004: Bun + Hono; two API surfaces; code-first OpenAPI

**Status:** Accepted · **Date:** 2026-08-19

## Decision
Runtime Bun, framework Hono, TypeScript end-to-end, Bun workspaces for the monorepo.
Two API surfaces in one app: (1) public `/v1` — versioned, enveloped REST built as an
OpenAPIHono sub-app whose Zod schemas from packages/contracts drive validation, types,
and the OpenAPI spec simultaneously; docs served at `/docs` (Scalar) with the API-key
securityScheme so integrators can call the API from the browser. (2) Internal console
surface — plain Hono routes consumed via Hono RPC (`hc<AppType>`) into TanStack Query.

## Context
Hono is web-standards based and runs identically on Bun, Node, and serverless runtimes,
making the runtime choice cheap to reverse. RPC-style coupling is pure win internally
but must never leak into the public contract.

## Consequences
- If Bun misbehaves in production, swap the entrypoint; app code survives.
- The public spec cannot drift: it is generated from the same schemas that validate.
- OTel auto-instrumentation is weaker on Bun; instrumentation is manual (ADR-0007).
