/**
 * Request headers both sides of the wire have to spell the same way.
 *
 * These live here rather than in `apps/api` for the reason CONVENTIONS gives for this
 * package existing at all: a string that two codebases must agree on is type truth, and the
 * console is now one of the two. `session.ts` carried this constant while it had three
 * readers that were all in `apps/api`; the console became a fourth in M4 phase 7, and the
 * console cannot import from `apps/api/src/middleware` — that module pulls better-auth and a
 * database pool, none of which belongs in a browser bundle.
 */

/**
 * The header the console names its ACTIVE org with (ADR-0047).
 *
 * Four places must agree on this spelling and only one of them can be wrong silently:
 * `middleware/session.ts` reads it, `routes/internal/index.ts` must allow it through the
 * CORS preflight, the API's tests assert on it, and `apps/web` sends it. A custom request
 * header is not on the CORS safelist, so a header read by the middleware and forgotten in
 * `allowHeaders` fails ONLY in a real browser — never in a test, which sends no preflight.
 *
 * The value is an org ID, not a slug. The server validates it against the account's
 * memberships and answers `NOT_FOUND` — never `FORBIDDEN` — for one it is not a member of,
 * so the response cannot confirm that an org exists (ADR-0057).
 */
export const ACTIVE_ORG_HEADER = 'X-LabelLoop-Org'
