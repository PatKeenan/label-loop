# ADR-0001: Server-side trace capture (gateway architecture)

**Status:** Accepted · **Date:** 2026-08-19

## Decision
The platform is the inference path: customer requests hit our endpoint, we call the
model provider, we persist the trace. Traces (input, output, model, classifier
version, latency, tokens, cost) are captured server-side on 100% of traffic.

## Context
Observability vendors (LangSmith etc.) must ship client SDKs to capture other
people's model calls. We do not: the call already flows through us.

## Consequences
- No client-side trace shipping, ever. The SDK carries requests, not telemetry.
- Sampling, judging, and dataset curation see complete traffic, not instrumented subsets.
- We own provider latency: resilience work (ADR in M2) is mandatory, not optional.
- Customer trust burden: data handling, retention, and PII masking are product features.
