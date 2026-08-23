# ADR-0010: Two identifiers — `request_id` (execution) and `trace_id` (record)

**Status:** Accepted · **Date:** 2026-08-21

## Decision
The API exposes two distinct identifiers and never conflates them.

- **`request_id`** — the W3C/OTel trace id for one HTTP execution. Present on EVERY
  response, success and failure, on every endpoint. Carried on every log line and every
  span. This is the id a customer quotes to support.
- **`trace_id`** — a `tr_` ULID naming a row in the `traces` table: one stored
  evaluation. Exists only for panel/judge evaluation, returned inside `data`, permanent,
  and the id the trace explorer, annotation surfaces, eval scores, and dataset rows
  address.

The response envelope therefore carries `request_id`, not `trace_id`:
`{ data, request_id }` / `{ error: { code, message }, request_id }`. The `traces`
table stores both — its `tr_` primary key and a `request_id` column — which is the join
between a business record and its telemetry.

## Context
The word "trace" means two unrelated things in this project. The observability industry
uses it for a request's timing breakdown; our product uses it for a saved
evaluation (PRODUCT.md 5.4, the trace explorer, the object SMEs annotate). The
original envelope spec said `trace_id` without saying which, and the two objects differ
in every meaningful way: one is created for all traffic and expires with backend
retention, the other is created only by an evaluation and is kept permanently.

The failure path decides which belongs in the envelope. If the envelope carried the
`tr_` id, a request that 500s before persisting has no id to return — precisely the
case where a caller most needs one. The execution id exists from the moment the request
arrives, so it is the only candidate that survives failure.

## Consequences
- Support debugging works uniformly: any response, including errors on non-evaluation
  endpoints, yields an id that resolves to spans and logs.
- Product lookups stay stable: `tr_` ids outlive trace retention, so the annotation and
  eval surfaces never depend on an observability backend's TTL.
- The public contract gains a naming distinction that must hold for the life of `/v1`;
  changing it later means a new API version (CONVENTIONS.md API rules).
- Trace-to-record navigation is possible in both directions via the `request_id` column
  on `traces`, but only while the tracing backend retains the spans — an expected,
  documented asymmetry, not a bug.
