# ADR-0023: `data_collection: 'deny'` is a fixed invariant, recorded per judge version

**Status:** Accepted · **Date:** 2026-08-29

## Decision
Every `model_pin` (ADR-0022) carries `data_collection: 'deny'`, and at M1 that is the **only
writable value**. It is a stored value on each immutable row, not an ambient default and not a
per-judge toggle in the console.

This discharges the mitigation ADR-0021 committed to when it chose OpenRouter: *"a configuration
we must set and keep set, not a default we inherit."*

## Context
ADR-0021 named data governance as the single weakest axis of routing judge inference through an
aggregator, because some upstream tiers — particularly free and heavily discounted ones — log or
train on prompts. The mitigation is a request-side routing constraint excluding providers that
collect user data.

The question was whether that constraint is fixed or configurable. The tension is real: `deny`
excludes exactly the cheapest endpoints, and this is a solo-funded project.

**Two findings settled it.**

*The cost is smaller than it feels.* A judge call is a bounded artifact plus a rationale capped
at 280 characters — roughly 2,000 input and 150 output tokens, about **$0.008 per judge call**
and ~5¢ per six-judge panel evaluation at current mid-tier pricing. **Measured on 2026-08-29
against a small artifact, the real figures were lower still** — $0.0023 for Sonnet 5, $0.0012 for
gpt-5.6-sol, $0.00098 for Gemini 3.7 Flash — so the estimate is conservative by roughly 4x at that
size. The endpoints `deny` removes are disproportionately the weakest models, which are useless as
M7's "held-out comparison vs frontier" baseline anyway.

*The asymmetry is decisive.* Adding a second writable value later is additive — every row
already records what it was, so the two populations stay distinguishable. Removing a toggle
later is a migration plus an audit of which judges predate the tightening, which is precisely
the quiet erosion ADR-0021's expiry condition exists to prevent.

### Alternatives considered

**A per-judge toggle.** Buys access to cheap endpoints for bulk runs over synthetic data at
M6/M7. Rejected: shipping a switch that disables the mitigation in the same milestone that
adopts it makes ADR-0021's commitment decorative, and the M6/M7 batch paths can carry their own
decision later without the judge picker having to expose one now.

**An ambient default in config.** Rejected because it is unauditable after the fact: nothing on
the row would say what a given judge was created under.

## Consequences
- The value is written on every `jdv_` even though only one value is currently writable. That
  redundancy is the point — it is what makes a future exception auditable rather than guessed at.
- **`deny` is not gateable in a picker.** Neither the endpoints API nor the providers API exposes
  a data policy; the providers API offers a `privacy_policy_url`, a link for a human. So the
  constraint is enforced only at request time, invisibly, and its effect on pool size cannot be
  predicted from the catalogue.
- Combined with the capability requirement, the routing pool can be **empty**, which surfaces as
  a 503. ADR-0022's creation-time validation is what converts that from a permanently broken
  judge into a form error.
- **The narrowing is now measured rather than feared.** On 2026-08-29 the full pin left
  `anthropic/claude-sonnet-5` with 5 endpoints of 9 — one fewer than the capability gate alone
  predicted, so `deny` cost exactly one — and left **`openai/gpt-5.6-sol` with 1 of 5**, i.e. no
  failover at all, because its Azure endpoints pass the capability gate and are excluded by this
  invariant. That is the concrete shape of the price being paid here, and it is why ADR-0022
  requires the available count to be recorded at creation.
- **We must not present this as a privacy guarantee to any customer.** We are trusting an
  upstream filter, which is the thing ADR-0021 says will not survive a contract review. What we
  can honestly produce is evidence rather than a claim: `served_by` records which endpoint
  actually answered, per call.
- **Revisit trigger is concrete, not budgetary:** a specific model returning 503 at creation-time
  validation because nothing routes under `deny`. That is a real case with a name, and the right
  moment to decide whether one judge earns an exception.

Log: `thoughts/shared/progress/decisions-log.md` (2026-08-29)
Related: ADR-0021 (expiry condition), ADR-0022 (the pin this value lives on)
