import type { IdPrefix } from '@labelloop/contracts'
import { newId, ULID_CHARS } from '@labelloop/contracts'
import { sql } from 'drizzle-orm'
import { check, type PgColumn, pgEnum, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The column shapes every table shares, in one place so a new table cannot quietly
 * invent its own convention.
 */

/**
 * A primary-key column holding a prefixed ULID.
 *
 * The id is minted in the APPLICATION rather than by a database default, and that is a
 * decision rather than an omission. A `gen_random_uuid()` default cannot be known until
 * the INSERT returns, but an evaluation wants its `tr_` id at the *start* — bound to the
 * request logger so every judge-call line carries it, before the row exists. Generating it
 * here keeps both doors open: `$defaultFn` fills it in when nothing supplies one, and an
 * explicit id is still accepted whenever the caller needs it early.
 *
 * The prefix stays a prefixed ULID rather than becoming a UUID because it is public
 * contract (it appears in `/v1` paths and every response body), because the prefix is what
 * makes an id self-describing in a log line and a support ticket, and because ULIDs sort
 * by time — which on `traces`, the highest-volume insert table here, is the difference
 * between appending to a B-tree and scattering page splits across it.
 *
 * NOTE: this default belongs to the query builder. Raw SQL — the seed, any future backfill
 * — bypasses it entirely, which is why `idCheck` below is the actual guarantee.
 */
export const id = <P extends IdPrefix>(prefix: P, name = 'id') =>
  text(name).$defaultFn(() => newId(prefix))

/**
 * The prefix check for a primary key. Applied to primary keys only — a foreign key
 * inherits its correctness from the key it references, and the branded types in
 * `contracts` already make a `pnl_` unassignable to a `jdv_` at compile time. This is the
 * backstop for the one place an id enters the system from outside TypeScript: a seed
 * script, a psql session, a future import job.
 */
export const idCheck = (table: string, column: PgColumn, prefix: IdPrefix) =>
  // `sql.raw` rather than an interpolation: an interpolated value becomes a bind
  // parameter, and a `$1` in a CHECK constraint is a migration that will not run. The
  // pattern is built from a closed prefix list and a constant, so nothing untrusted
  // reaches it.
  check(
    `${table}_id_prefix`,
    sql`${column} ~ ${sql.raw(`'^${prefix}[0-9A-HJKMNP-TV-Z]{${ULID_CHARS}}$'`)}`,
  )

/**
 * Timestamps are `timestamptz` and named with an `_at` suffix (CONVENTIONS.md "API
 * rules"). `withTimezone` is not decoration: a `timestamp` without it silently discards
 * the offset, which is how "UTC everywhere" quietly becomes "whatever the server's
 * timezone was that day".
 */
export const timestampAt = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' })

export const createdAt = () => timestampAt('created_at').notNull().defaultNow()

export const updatedAt = () => timestampAt('updated_at').notNull().defaultNow()

/**
 * A judge's polarity, and the reason it is three-valued rather than a boolean (ADR-0019).
 * `is-missing-repro: true` is a failure, `on-brand: true` is a success, and `is-bug: true`
 * is neither — it is a label with no valence. Modelling this as a boolean makes the panel
 * score uncomputable, because summing raw verdicts across judges that mean opposite things
 * produces a number that looks meaningful and is not.
 *
 * A Postgres enum rather than application-level validation: the constraint is a property
 * of the data, and the one thing that must still hold when a row arrives from a seed
 * script, a backfill, or a psql session.
 */
export const judgePolarity = pgEnum('judge_polarity', ['passes', 'fails', 'does_not_score'])

/**
 * `code` judges are deterministic checks — a schema assertion or a regex — with near-zero
 * cost and latency and perfect precision by construction. `llm` judges are the ones that
 * cost money and need aligning (CONVENTIONS.md "Data rules").
 */
export const judgeType = pgEnum('judge_type', ['code', 'llm'])

/**
 * One policy, deliberately (ADR-0019). `weighted_threshold` already expresses the named
 * policies people ask for: "unanimous" is a threshold of 1, "quorum(n)" is equal weights
 * with the threshold set accordingly, and "veto" is a `required` judge. Four policies
 * would be four code paths and four sets of edge cases for one behaviour. It is an enum
 * with a single value rather than a dropped column because the column is the seam a
 * second policy would arrive through, and every evaluation echoes it.
 */
export const aggregationPolicy = pgEnum('aggregation_policy', ['weighted_threshold'])

/** Revocation is a status flip, never a row delete (CONVENTIONS.md "Keys & auth"). */
export const apiKeyStatus = pgEnum('api_key_status', ['active', 'revoked'])

/** PRODUCT.md 5.1. Org-scoped, on `org_members` rather than the user record (ADR-0014). */
export const orgRole = pgEnum('org_role', ['admin', 'engineer', 'annotator', 'guest_expert'])

/**
 * Why a judge's verdict is what it is, mirroring the closed `status` in the published
 * contract. `evaluated` is the only one that carries an answer; the rest exist so a
 * caller is never handed a "pass" for a judge that never ran.
 */
export const verdictStatus = pgEnum('verdict_status', [
  'evaluated',
  'skipped_sampling',
  'failed',
  'error',
])
