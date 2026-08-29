# ADR-0026: Pin validation is an ordinary port call, recorded separately, with no escape hatch

**Status:** Accepted · **Date:** 2026-08-29 · **Milestone:** M1

## Decision
ADR-0022 requires a real call to validate a pin before the `jdv_` freezes. That call is an
**ordinary `evaluate()`**, not a new port method: `ProviderResult` gains
`availableEndpoints?`, read from routing metadata. Its result is stored in its **own
`model_pin_validation` jsonb column** (`validated_at`, `available_endpoints`, `served_by`),
not inside `model_pin`. The seed validates every non-`fake:` pin and **fails outright** when
one does not route; there is no `SEED_VALIDATE_PINS` switch.

## Context
The port is documented as deliberately one method — a second verb would be owed by every
adapter that ever follows, to serve one caller. And the pin is a *constraint translated onto
the wire* while the endpoint count is a *measurement taken once*: merging them would ship
non-request data inside the request body.

## Consequences
- `db:setup` fails when the provider is unreachable, locally and in any deploy that inherits
  it. Accepted: a judge frozen against a pin that routes nowhere is permanently broken, and a
  seed that refuses beats a panel that 503s per call.
- A safety check with an escape hatch is a safety check that dies the first busy afternoon,
  which is why no switch ships alongside it.
- M4's judge wizard is where an unsatisfiable pin becomes a literal form error.

Full rationale: `thoughts/shared/plans/approved/2026-08-29_m1-endpoint-spine.md` (P4, Decisions 3, 4, 12). Both confirmed by the stakeholder 2026-08-29.
