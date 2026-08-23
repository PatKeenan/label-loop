# ADR-0001: Server-side trace capture (gateway architecture)

**Status:** Accepted (amended 2026-08-22 by ADR-0019) · **Date:** 2026-08-19

## Decision
The platform is the inference path: customer requests hit our endpoint, we call the
model provider, we persist the trace. Traces (artifact, verdict, reasoning, model, judge
version, latency, tokens, cost) are captured server-side on 100% of traffic.

## Amendment 2026-08-22 — the gateway is for JUDGE calls
ADR-0019 narrows what "the inference path" means here, and it is a narrowing rather than a
reversal. We do **not** generate the caller's artifact — their agent does that, in their
own orchestration. What flows through us is the **judge** call: the customer configures
which model their judges run on, we route it, and we persist the trace. Every consequence
below still holds, because the call we capture is still our own.

Two things follow. "Which model produced the artifact" becomes caller-supplied metadata
rather than something we control. And the graduation story runs through the judges: because
the judge call is ours, swapping its model for a fine-tune is a configuration change on our
side rather than a change in the customer's code.

## Context
Observability vendors (LangSmith etc.) must ship client SDKs to capture other
people's model calls. We do not: the call already flows through us.

## Consequences
- No client-side trace shipping, ever. The SDK carries requests, not telemetry.
- Sampling, judging, and dataset curation see complete traffic, not instrumented subsets.
- We own provider latency: resilience work (ADR in M2) is mandatory, not optional.
- Customer trust burden: data handling, retention, and PII masking are product features.
