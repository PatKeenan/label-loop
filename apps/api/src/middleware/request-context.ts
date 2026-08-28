import { isSpanContextValid, trace } from '@opentelemetry/api'
import type { MiddlewareHandler } from 'hono'

/**
 * Stamps every execution with a `request_id` (ADR-0010) before anything but tracing runs,
 * so the logger, the envelope and the error path all quote the same string.
 *
 * **This was the P2 seam, and P6 closed it.** The id used to be minted here; it is now
 * READ from the active span's trace id, which `middleware/tracing.ts` put there. That is
 * what makes ADR-0010's claim — "the W3C/OTel trace id for one HTTP execution" — literally
 * true rather than merely shaped the same: paste a `request_id` into Tempo and the trace
 * is there, because it is the same 32 hex characters and not a parallel identifier that
 * happens to look alike. One function changed and no contract did, which is what the
 * staging was for.
 */

/** The context key. `c.var.requestId` is typed through `AppEnv` in `app-env.ts`. */
export const REQUEST_ID_KEY = 'requestId'

/** Echoed on every response so a caller can find the id without parsing a body. */
export const REQUEST_ID_HEADER = 'x-request-id'

const HEX = '0123456789abcdef'

/**
 * A W3C trace id: 16 random bytes as 32 lowercase hex characters. Not `crypto.randomUUID`
 * — a UUID is 36 characters with dashes and version bits, which is not the same shape.
 *
 * Still here as the fallback for the one case that has no span: a process with no tracer
 * provider installed, which is every unit test that builds `createApp` without one. The
 * envelope contract does not get to depend on telemetry being configured.
 */
export const generateRequestId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let out = ''
  for (const byte of bytes) out += HEX.charAt(byte >> 4) + HEX.charAt(byte & 15)
  // The all-zero id is reserved as "invalid" by the W3C spec; astronomically unlikely,
  // but a one-character guard is cheaper than the debugging session.
  return out === '0'.repeat(32) ? generateRequestId() : out
}

/**
 * The trace id of the span we are inside, or a fresh one if we are inside none.
 *
 * `isSpanContextValid` is doing real work rather than being defensive: OTel's no-op tracer
 * — what you get before any provider is registered — returns a span whose context is
 * thirty-two zeroes. Handing that out would put the SAME `request_id` on every response
 * in an unconfigured deployment, which is worse than a random one because it looks valid.
 */
export const currentRequestId = (): string => {
  const spanContext = trace.getActiveSpan()?.spanContext()
  return spanContext !== undefined && isSpanContextValid(spanContext)
    ? spanContext.traceId
    : generateRequestId()
}

export const requestContext = (): MiddlewareHandler => async (c, next) => {
  const requestId = currentRequestId()
  c.set(REQUEST_ID_KEY, requestId)
  c.header(REQUEST_ID_HEADER, requestId)
  await next()
}
