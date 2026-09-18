# ADR-0070: Organisation settings go live at M5, with Members as the first screen

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5 · **Amends:** ADR-0059

## Decision
The account menu's Organisation settings entry — inert and marked M8 until now — opens a Members screen at M5: invite, change role, remove, revoke invitations. Still **admin-only** (`member: [manage]`), still behind the server guard. An org must always keep one admin.

## Context
ADR-0059 kept the entry absent until M8 because its first contents (audit log, billing) were M8's. Member management arrived first, as M5's prerequisite (ADR-0064), so the entry has real content two milestones early.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decisions 13, 14)
