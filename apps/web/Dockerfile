# syntax=docker/dockerfile:1

# The console's image. Like the API's, it is built from the REPO ROOT as its context: the
# lockfile and the workspace manifests live above this directory.
#
# Two things about this image are worth knowing before reading it. It contains no
# `node_modules` and no JavaScript runtime at all — Vite bundles everything the browser
# needs, and nginx hands out the result. And its API URL is baked in at BUILD time, not read
# at runtime, because that is what Vite does with `import.meta.env`: an image built for one
# origin cannot be re-pointed at another by an environment variable.

ARG BUN_VERSION=1.4.0

# ---------------------------------------------------------------------------------------
# Stage 1 — dependencies. A FULL install, unlike the API's: Vite and the React plugin are
# devDependencies, and they are exactly what the next stage runs.
# ---------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-alpine AS deps
WORKDIR /app

COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/

RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------------------
# Stage 2 — the bundle.
# ---------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app

# The base tsconfig every workspace extends. Vite reads `apps/web/tsconfig.json` to pick up
# the JSX and target settings, and a config whose `extends` cannot be resolved is a hard
# failure rather than a fallback to defaults.
COPY tsconfig.base.json ./
COPY packages ./packages
# The console imports the API's `AppType` to type its RPC client. It is a type-only import
# and erased before anything is bundled, but the source has to be resolvable for the
# typecheck-free esbuild pass to agree, and this stage is discarded either way.
COPY apps/api ./apps/api
COPY apps/web ./apps/web

# Where the BROWSER reaches the API — not where this container would. Vite inlines it, so
# it is a build arg rather than an environment variable, and compose passes the same value
# it publishes the API's port on.
ARG VITE_API_URL=http://localhost:3000
ENV VITE_API_URL=${VITE_API_URL}

RUN bun run --cwd apps/web build

# ---------------------------------------------------------------------------------------
# Stage 3 — runtime. nginx and the bundle, and nothing else.
#
# The UNPRIVILEGED image rather than plain `nginx`, and the reason is a property worth not
# losing: the official image's master process runs as root, and everything else this repo
# ships runs as an unprivileged user. This variant is the same nginx from the same
# maintainers, listening on 8080 as uid 101 — which also happens to be the port the compose
# file already publishes from.
# ---------------------------------------------------------------------------------------
FROM nginxinc/nginx-unprivileged:1.29.3-alpine AS runtime

# Carried for parity with the API image (ADR-0011). Nothing in a static bundle reads them;
# they are here so `docker inspect` can answer "which build is this" for both images the
# same way, without the reader having to know which one bakes its version into JavaScript.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA}

COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# Replaces the image's default server block. Everything specific to this app is in there.
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

# The shell is the whole application, so serving it IS the health of this container. There
# is no dependency to check and deliberately no check of the API's: a console that cannot
# reach the API should render the error it already knows how to render, not be killed.
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=6 \
  CMD wget --no-verbose --spider --tries=1 http://127.0.0.1:8080/ || exit 1

# The base image's own entrypoint and CMD start nginx in the foreground. Restating them here
# would be a second copy of something the maintainers already get right.
