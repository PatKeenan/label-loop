import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../app-env.ts'
import { AppError } from '../errors.ts'
import { findApiKeyByHash } from '../repositories/api-keys.ts'

/**
 * API-key authentication for the public surface (ADR-0003, CONVENTIONS.md "Keys & auth").
 *
 * Three rules, and the third is the one worth reading twice:
 *
 * 1. Only the SHA-256 of a key is stored, so a database dump is not a set of working
 *    credentials. The lookup hashes what was presented and matches on that.
 * 2. Revocation is a status flip, never a delete — the audit trail has to survive it — so
 *    finding a row is not the same as being authorised.
 * 3. **Every key is scoped to exactly one panel, and a key for a DIFFERENT panel is
 *    rejected as 401, not 403.** A 403 would confirm the panel exists and that the caller
 *    is simply not allowed at it, which hands an attacker a panel-id oracle. Every
 *    rejection here is the same status, the same code and the same sentence.
 *
 * Web sessions never come through this path (CONVENTIONS.md): API keys grant no console
 * access, and P7's session middleware guards `routes/internal/*` separately.
 */

/** `llk_live_` for production traffic, `llk_test_` against a throwaway database. */
const KEY_PREFIXES = ['llk_live_', 'llk_test_'] as const

/**
 * One message for every failure. Naming which of the four checks failed would tell an
 * attacker whether a key exists, whether it is revoked, and which panel it belongs to —
 * three facts they cannot otherwise obtain, in exchange for debugging help nobody
 * legitimate needs (a real integrator has the key and knows what they pasted).
 */
const UNAUTHORIZED = 'Provide a valid API key for this panel as `Authorization: Bearer <key>`.'

/** What the rest of the request may assume once this middleware has run. */
export type AuthenticatedKey = {
  id: string
  orgId: string
  panelId: string
}

export const sha256Hex = (value: string): string =>
  new Bun.CryptoHasher('sha256').update(value).digest('hex')

const presentedKey = (header: string | undefined): string | undefined => {
  if (header === undefined) return undefined
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined) return undefined
  return KEY_PREFIXES.some((prefix) => token.startsWith(prefix)) ? token : undefined
}

/**
 * Guards a route whose path names the panel the key must be scoped to. The parameter name
 * is passed in rather than assumed, so the single-judge endpoint (M1) can reuse this
 * without the middleware quietly reading the wrong segment.
 */
export const apiKeyAuth = (panelParam = 'panel_id'): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const unauthorized = (reason: string): AppError =>
      // The reason is kept for the log line and for the error tracker, and never for the
      // caller — `AppError.context` is not serialized into the envelope.
      new AppError('UNAUTHORIZED', UNAUTHORIZED, { context: { reason } })

    const token = presentedKey(c.req.header('authorization'))
    if (token === undefined) throw unauthorized('missing or malformed Authorization header')

    const key = await findApiKeyByHash(c.var.deps.db, sha256Hex(token))
    if (key === undefined) throw unauthorized('no key matches that hash')
    if (key.status !== 'active') throw unauthorized('the key is revoked')
    if (key.panelId !== c.req.param(panelParam)) {
      throw unauthorized('the key is scoped to a different panel')
    }

    c.set('apiKey', { id: key.id, orgId: key.orgId, panelId: key.panelId })
    // The key, never the plaintext, and never a fragment of it: a log stream is not an
    // access-controlled store, and last-4 is for the console, not for here.
    c.var.logger.assign({ api_key_id: key.id, org_id: key.orgId })
    await next()
  }
}
