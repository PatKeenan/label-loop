# ADR-0005: React SPA on Vite + TanStack Router/Query

**Status:** Accepted · **Date:** 2026-08-19

## Decision
The console + annotator surface is a client-rendered React SPA built with Vite,
TanStack Router, and TanStack Query. No SSR framework.

## Context
The app is entirely authenticated tooling: zero SEO or first-paint-marketing needs.
Next.js explicitly ruled out by the stakeholder. Hono RPC types flow into TanStack
Query for end-to-end inference without codegen.

## Consequences
- Simpler deploy (static assets + API), simpler mental model, faster builds.
- Marketing site, if ever needed, is a separate concern (parking lot).
