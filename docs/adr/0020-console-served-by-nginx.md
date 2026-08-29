# ADR-0020: The console's container is served by nginx

**Status:** Accepted · **Date:** 2026-08-28

## Decision
The console image's runtime stage is `nginxinc/nginx-unprivileged:1.29.3-alpine`, with a
committed `apps/web/nginx.conf`. It replaces a hand-written ~40-line Bun static server
(`apps/web/serve.ts`), which is deleted. Pinned, never `:latest` (ADR-0011). The
unprivileged variant rather than the official image, because plain `nginx`'s master process
runs as root and everything else this repo ships runs unprivileged; it listens on 8080 as
uid 101, which is already the port compose publishes from.

nginx serves static files only. It is deliberately **not** a reverse proxy in front of the
API: the browser still reaches the API cross-origin, which is what keeps the real CORS
allow-list and the real cross-origin session cookie under test rather than hidden behind a
same-origin shortcut.

## Context
A static SPA bundle needs something in the container to serve it, and nginx had no row in
STACK_DECISIONS, which makes it a stakeholder-owned call (CLAUDE.md). M0-P8 shipped
`serve.ts` instead — forty lines of Bun, no new tool, one pinned base image across both
containers — and flagged the choice for review rather than deciding it.

Review found the argument that settled it: **`serve.ts` did not compress.** It sent the
full 433,385-byte bundle to every visitor where nginx sends 137,155 — a 3.2x difference on
the single largest asset the product serves, obtained from one directive. That is the one
place where nginx's battle-tested defaults were a concrete advantage rather than an
abstract one. Compression was closable in Bun in a few lines, but by then the question had
become "how much of nginx do we intend to reimplement", and the honest answer was that a
static file server is not the part of this system worth demonstrating from scratch.

The costs are accepted rather than dismissed: a second base image in the Dependabot
rotation and its own CVE stream, and a second configuration language in the repo. They are
real, and smaller than the class of thing a hand-rolled server keeps finding.

This does not weaken ADR-0012. Hand-rolling is reserved for the resilience primitives
inside `llm/`, which *are* the artifact this project exists to demonstrate. Serving a
directory over HTTP is not, and the two were never the same argument.

## Consequences
- The console's bundle is gzipped in transit. Nothing else changes for a reader: the
  compose file, the published port and the dev overlay are untouched.
- Behaviour is preserved and verified rather than assumed — SPA fallback for client routes,
  a real `404` for a missing fingerprinted asset (never the HTML shell, which a browser
  reports as a syntax error), `immutable` caching for `/assets/`, `no-store` for the shell,
  and `nosniff`. nginx additionally rejects a path-traversal attempt with a `400` where the
  Bun server answered with the SPA shell.
- The console image no longer contains a JavaScript runtime — 53.9 MB of nginx and static
  files, with no `node_modules` and nothing executable from the bundle's own dependencies.
- The dev overlay (ADR-0018) is unaffected: it already stops at the `build` stage and runs
  Vite's dev server, so it never touched the runtime stage either way.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (P8 deviations)
