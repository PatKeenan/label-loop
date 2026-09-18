# ADR-0065: Membership by pending invitation, claimed on first sign-in against a verified email

**Status:** Accepted · **Date:** 2026-09-18 · **Milestone:** M5

## Decision
An admin invites a person by email and role. The invitation is stored (`org_invitations`, `inv_`), sent nowhere, and **claimed on the account's next `/internal/me`** when its **verified** email matches: one transaction inserts the `org_members` row, stamps the invitation accepted, and writes `invitation.accepted`. Invitations expire after 14 days and are revocable. An unverified email claims nothing.

## Context
Adding existing accounts only would fail for anyone who has never signed in, and invitation emails need an email provider — a stakeholder-owned stack decision this plan does not make. Emails can be layered onto the same table later.

Plan: `thoughts/shared/plans/approved/2026-09-18_m5-members-annotation.md` (decisions 1, 15)
