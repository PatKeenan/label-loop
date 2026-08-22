import type { MiddlewareHandler } from 'hono'

/**
 * Stamps every execution with a `request_id` (ADR-0010) before anything else runs, so
 * the logger, the envelope and the error path all quote the same string.
 *
 * **This is a deliberate seam.** At M0-P6 the OpenTelemetry SDK arrives and
 * `generateRequestId` is replaced by a read of the active span's trace id — at which
 * point logs, spans and responses agree by construction rather than by coincidence.
 * The format is already W3C so that swap changes one function and no contract.
 */

/** The context key. `c.var.requestId` is typed through `AppEnv` in `app.ts`. */
export const REQUEST_ID_KEY = 'requestId'

/** Echoed on every response so a caller can find the id without parsing a body. */
export const REQUEST_ID_HEADER = 'x-request-id'

const HEX = '0123456789abcdef'

/**
 * A W3C trace id: 16 random bytes as 32 lowercase hex characters. Not `crypto.randomUUID`
 * — a UUID is 36 characters with dashes and version bits, which is not the same shape.
 */
export const generateRequestId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (const byte of bytes) out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15)
  // The all-zero id is reserved as "invalid" by the W3C spec; astronomically unlikely,
  // but a one-character guard is cheaper than the debugging session.
  return out === '0'.repeat(32) ? generateRequestId() : out
}

export const requestContext = (): MiddlewareHandler => async (c, next) => {
  const requestId = generateRequestId()
  c.set(REQUEST_ID_KEY, requestId)
  c.header(REQUEST_ID_HEADER, requestId)
  await next()
}
