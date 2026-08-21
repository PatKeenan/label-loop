# ADR-0002: REST-only integration surface; SDK descoped

**Status:** Accepted (amended 2026-08-19: SDK descoped entirely) · **Date:** 2026-08-19

## Decision
Integration surface is plain REST from M1, permanently for this portfolio's scope:
OpenAPI spec at /openapi.json, interactive Scalar docs at /docs (with API-key
securityScheme so integrators can call from the browser), and documented fetch/curl
snippets. No SDK package. If an SDK ever returns, it is generated from the OpenAPI
spec, never hand-written.

## Context
Per ADR-0001 the SDK has no telemetry duties. A premature SDK is surface area without
checklist value; a thin one later demonstrates client-side resilience and API design.

## Consequences
- Docs lead with curl; the demo works with zero customer dependencies.
- SDK can never drift from the API: it is generated from the same contracts package.
- Client-side backoff+jitter becomes a demonstrable Category-5 artifact.
