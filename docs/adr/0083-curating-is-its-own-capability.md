# ADR-0083: Curating and assigning are their own capability

**Status:** Accepted · **Date:** 2026-09-20 · **Milestone:** M5 (phase 7)

## Decision
`annotation: ['curate']` joins the capability map (ADR-0064), held by `admin` and `engineer`.
Creating a set, topping it up, and assigning annotators to it are that capability; `annotator`
keeps `annotation: ['create']` and cannot curate.

## Context
Choosing what someone's afternoon is spent on is not the same act as spending it. The split also
keeps the map honest about the product: an annotator's whole surface is work given to them, which
is what ADR-0079 makes structural.

Plan: `thoughts/shared/plans/approved/2026-09-20_review-sets.md` (decision 13)
