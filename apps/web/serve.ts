import { resolve } from 'node:path'

/**
 * The console's production server: about forty lines of Bun, serving the Vite build.
 *
 * Why this and not nginx or Caddy. A static file server is the only thing this image has
 * to do, and reaching for a second runtime to do it would add a base image to patch, a
 * config language to learn, and a technology row to STACK_DECISIONS — for behaviour that
 * fits on one screen. Bun is already the runtime this project runs on, so the console's
 * container and the API's container are the same base image at the same pinned version.
 *
 * It is deliberately NOT a reverse proxy. The browser talks to the API directly at
 * `VITE_API_URL`, which is why the API has a real CORS allow-list and a real cross-origin
 * session cookie rather than the same-origin shortcut a proxy would have hidden.
 */

/** Where the build landed. `dist/` sits beside this file inside the image. */
const DIST = resolve(import.meta.dir, 'dist')

const PORT = Number(process.env.PORT ?? 8080)

/**
 * Vite fingerprints everything under `assets/`, so those files can never change under a
 * given name and are cached for a year. `index.html` is the opposite: it is the document
 * naming the current fingerprints, so a cached copy is how a browser ends up asking for a
 * bundle that no longer exists.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable'
const NO_STORE = 'no-store'
const ASSETS = '/assets/'

/**
 * Map a request path to a file inside `dist`, or to nothing.
 *
 * `resolve` collapses `..` before the check, so a traversal attempt resolves to somewhere
 * outside `DIST` and is rejected here rather than reaching the filesystem. Decoding first
 * matters: `%2e%2e` is the same request with a costume on.
 */
const fileFor = (pathname: string): string | undefined => {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  const candidate = resolve(DIST, `.${decoded}`)
  return candidate === DIST || candidate.startsWith(`${DIST}/`) ? candidate : undefined
}

const headers = (pathname: string) => ({
  'cache-control': pathname.startsWith(ASSETS) ? IMMUTABLE : NO_STORE,
  // The bundle is served from its own origin and nothing here sniffs; saying so is free.
  'x-content-type-options': 'nosniff',
})

const server = Bun.serve({
  port: PORT,
  // Explicit, because the default binds loopback and a container that only answers itself
  // is a container whose healthcheck passes and whose published port does nothing.
  hostname: '0.0.0.0',
  async fetch(request) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
    }

    const { pathname } = new URL(request.url)
    const path = fileFor(pathname)

    if (path !== undefined) {
      const file = Bun.file(path)
      if (await file.exists()) return new Response(file, { headers: headers(pathname) })
    }

    // A missing fingerprinted asset is a genuine 404 and must not be answered with HTML —
    // a browser handed `<!doctype html>` where it expected JavaScript reports a syntax
    // error, which is a long way from the truth.
    if (pathname.startsWith(ASSETS)) return new Response('not found', { status: 404 })

    // Everything else is a client route (TanStack Router owns them), so the SPA shell is
    // the correct answer — including for a URL that does not exist, which the router
    // renders as its own not-found rather than the server guessing.
    return new Response(Bun.file(resolve(DIST, 'index.html')), { headers: headers(pathname) })
  },
})

// One NDJSON line, the same shape the API's logger emits, written directly because this
// process is too small to justify pino and `console` is banned repo-wide.
process.stdout.write(
  `${JSON.stringify({
    level: 'info',
    service: 'labelloop-web',
    port: server.port,
    dist: DIST,
    msg: 'serving the console',
  })}\n`,
)
