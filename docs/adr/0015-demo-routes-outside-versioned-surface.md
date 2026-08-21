# ADR-0015: The error taxonomy is proven on real endpoints; synthetic routes stay outside `/v1`

**Status:** Accepted · **Date:** 2026-08-21

## Decision
Error codes are demonstrated against real endpoints wherever a real endpoint can do it:
422 by posting a malformed body to classify, 401 by presenting a missing, revoked, or
wrong-classifier key. Only 429 and 500 get synthetic routes, and those mount outside
`/v1`, documented in the README rather than the OpenAPI spec, and are deleted at M2.

## Context
`/v1` is a versioned public contract where a breaking change means a new version.
Publishing demo endpoints there and removing them later is self-inflicted contract churn.
Faking 422 also proves less than the real thing: a synthetic route only proves a synthetic
route can throw, whereas a malformed body proves contract-validation auto-mapping works.

## Consequences
- `/v1` contains only real product surface from its first commit.
- The required 422/401/429/500 demonstration is split across two build phases rather than
  landing in one, since 422 and 401 need a contract-bearing endpoint to exist first.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-I)
