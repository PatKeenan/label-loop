# ADR-0072: `guest_expert` grants no capability until M8

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5 (decided), M8 (built)

## Decision
The capability map gives `guest_expert` nothing at M5. Guest access arrives with its protections at M8.

## Context
PRODUCT.md 5.1 defines guest-expert access as time-boxed, panel-scoped, audited and PII-masked. Granting annotation without those would hand an outside expert every trace in the org.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decision 17)
