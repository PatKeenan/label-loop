# syntax=docker/dockerfile:1

# The API image. Built from the REPO ROOT as its context, not from this directory: this is
# a Bun workspace, and `apps/api` alone does not contain enough to install — the lockfile
# and every workspace manifest live above it.
#
# The same image runs the API and the migrate+seed one-shot. They are the same code with
# different privileges: the one-shot is handed the migrator and superuser connection
# strings, the API is handed only the app role's, and the API's config schema cannot even
# express the other two (`apps/api/src/config.ts`). One image, one build, two commands.

# Pinned, never `:latest` (ADR-0011). The container's Bun is the AUTHORITATIVE runtime for
# this project (plan D-K) — CI and the host track this number, they do not lead it.
ARG BUN_VERSION=1.4.0

# ---------------------------------------------------------------------------------------
# Stage 1 — dependencies.
#
# Only manifests and the lockfile are copied, so this layer is cached across every source
# change and re-runs only when a dependency actually moves. Copying the source first would
# invalidate the install on every keystroke.
# ---------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app

# Every workspace manifest, because `bun install --frozen-lockfile` verifies the lockfile
# against ALL of them and fails if one is missing. A new workspace means a new line here.
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/

# `--production` drops devDependencies: Biome, commitlint, drizzle-kit, the TypeScript
# compiler, Vite. None of them run in a container — the API executes TypeScript directly,
# so there is no build step to preserve them for.
#
# `--frozen-lockfile` is the point of committing bun.lock: the image installs exactly what
# CI installed and exactly what the developer installed, or it fails.
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------------------
# Stage 2 — runtime.
# ---------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

# Build provenance (ADR-0011): release-please sets the version, CI sets the SHA, and both
# arrive here as build args, become environment variables, and surface on `/healthz` and as
# `service.version` on every span. The defaults are the same placeholders `config.ts` uses
# for a local `bun run dev`, and `config.ts` REJECTS them when NODE_ENV=production — so an
# image built without them cannot quietly pretend to be a release.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

# Bun's isolated linker puts the store at the root and a symlink tree in every workspace,
# so the install is the whole `/app` tree rather than one `node_modules` directory. Copying
# the stage wholesale is what keeps that true as workspaces are added.
COPY --from=deps /app /app

# Source. `packages` before `apps` for no reason other than that it changes less often.
COPY packages ./packages
COPY apps/api ./apps/api
# The operational scripts and the root `package.json` that names them — this is what lets
# the migrate one-shot run `bun run db:setup` out of this same image.
COPY scripts ./scripts
COPY package.json ./package.json

# Unprivileged. The `bun` user ships in the base image.
USER bun

EXPOSE 3000

# `/readyz`, not `/healthz`. Compose gates the web container and CI's smoke run on this
# healthcheck, and what they need to know is "can this serve traffic" — which means
# Postgres is reachable, the migrations are current and the queue answers. `/healthz` would
# go green the instant the process bound its port, which is the wrong signal for a gate.
#
# `wget` is busybox's, present in the base image, and `--spider` makes a 503 a non-zero
# exit without downloading the body.
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD wget --no-verbose --spider --tries=1 http://127.0.0.1:3000/readyz || exit 1

# The entrypoint directly, not `bun run --cwd apps/api start`: that script exists to point
# a developer's process at the repo-root `.env`, and a container takes its configuration
# from the environment compose gives it (ADR-0009).
CMD ["bun", "run", "apps/api/src/server.ts"]
