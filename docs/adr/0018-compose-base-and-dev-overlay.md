# ADR-0018: A conservative base compose file plus a developer-only overlay

**Status:** Accepted · **Date:** 2026-08-21

## Decision
`infra/docker-compose.yml` boots the real production images and stays on a plain, widely
supported compose feature set. `infra/docker-compose.dev.yml` is a developer-machine-only
overlay providing the inner loop via `compose watch` with `action: sync` plus `bun --hot`
inside the container — not a bind mount. `rebuild` rules are scoped only to `bun.lock`,
`package.json`, and the Dockerfiles.

## Context
Two reasons rule out bind mounting. A bind mount of the repo shadows the image's
`/app/node_modules` (linux) with the host's (darwin-arm64), requiring an anonymous masking
volume per workspace — a list that grows silently and fails confusingly. And on macOS an
in-container watcher observing a host filesystem across the VM boundary is the classic
sustained-CPU pattern, whereas `sync` keeps the cost bursty. The base file stays
conservative because CI runs it and any future ECS translation is read against it.

## Consequences
- The fresh-clone demo boots the same images production runs; the overlay never touches it.
- A `rebuild` rule mis-scoped to a source path would turn every save into a full image
  build, so the scoping is written into the file rather than left to memory.
- Watched paths must be declared, and each save carries a small copy latency.

Plan: `thoughts/shared/plans/approved/2026-08-20_m0-walking-skeleton.md` (D-M, D-N)
