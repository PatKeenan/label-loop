# ADR-0011: Automated versioning with release-please; versions are traceable to running code

**Status:** Accepted · **Date:** 2026-08-21

## Decision
Version numbers are never written by hand. release-please runs as a GitHub Action,
derives the next version from conventional commits (`fix:` patch, `feat:` minor,
`feat!:`/`BREAKING CHANGE:` major), and maintains a standing Release PR carrying the
bump and the generated CHANGELOG. Merging that PR tags the commit and publishes the
GitHub Release — the merge is the "ship it" gesture.

The version then flows all the way to running code:

    release-please → package.json version + CHANGELOG.md + git tag
        → CI builds the container image tagged with BOTH the git SHA and the version
        → build args → config.ts → /healthz output + `service.version` on every span

Container images are NEVER tagged `:latest` for deploys. Immutable SHA tags are what
make "what is running in production right now" and "roll back to the previous build"
answerable rather than guesswork.

## Context
BUILD_SPINE's standing rules already required a tagged release per milestone but
specified no scheme, no notes mechanism, and no way for a deployment to identify
itself. Conventional commits are enforced (CONVENTIONS "Quality gates"), which is
exactly the input release automation consumes — the machinery was already half built.

semantic-release was rejected for releasing on every push to main, which is noisy on a
solo repo where several commits land in an hour. changesets was rejected as the wrong
shape: it targets multi-package publishing and requires hand-written changeset files,
which is more manual, not less. A manual `gh release create vX.Y.Z --generate-notes`
still requires choosing the number by hand.

Semver here is shaped like semver but is not a consumer contract: ADR-0002 descoped the
SDK, so nothing downstream depends on these numbers. The public API is versioned
independently by URL path (`/v1/`) and deliberately does not track release versions.

## Consequences
- Releases bump on commit cadence rather than once per milestone. Milestone boundaries
  are marked in the release title and notes ("v0.4.0 — M0 complete: walking skeleton"),
  not by hand-picked numbers. BUILD_SPINE's "tagged release per milestone" is satisfied
  by whichever release closes the milestone.
- The CHANGELOG becomes a public artifact generated from the commit narrative, which is
  itself a stated deliverable (STAKEHOLDER_VALUE).
- `service.version` on spans makes deploy-correlated regressions visible in Grafana:
  "p95 regressed after v0.4.0" becomes a query, not a hunch.
- Commit hygiene is now load-bearing. A mistyped commit type produces a wrong version
  bump, which is why commitlint is enforced rather than trusted (M0 repo genesis).
