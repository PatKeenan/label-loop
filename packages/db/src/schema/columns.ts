import type { IdPrefix } from '@labelloop/contracts'
import { newId, ULID_CHARS } from '@labelloop/contracts'
import { sql } from 'drizzle-orm'
import { check, jsonb, type PgColumn, pgEnum, text, timestamp } from 'drizzle-orm/pg-core'

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
 * A `jsonb` column that stores JSON, rather than a string that happens to contain JSON.
 *
 * **This used to be a hand-written custom type, and its deletion is the point** (ADR-0031).
 * Under Bun's driver, Drizzle's own `jsonb()` composed into a DOUBLE encoding — Drizzle
 * called `JSON.stringify` on the way out and Bun's driver serialized the resulting string
 * again, so Postgres stored a jsonb *string*. The workaround was identity in both
 * directions, leaving the encoding to the driver.
 *
 * Under `node-postgres` that workaround became the bug it was written against, and worse:
 * a pass-through hands `pg` a raw JS array, which it serializes as a Postgres ARRAY
 * literal — `{a,b}` — that a jsonb column rejects outright. Drizzle's stock behaviour is
 * simply correct here, because `pg` sends text as text.
 *
 * So this is now a thin alias kept for its NAME and its type parameter. It stays rather
 * than being inlined because the call sites read better and because
 * `jsonb-encoding.test.ts` — which asserts what Postgres actually holds, in SQL — is
 * anchored to this one seam.
 */
export const jsonbColumn = <TData>(name: string) => jsonb(name).$type<TData>()

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

/**
 * The lifecycle of ONE delivery attempt of a job, recorded in a table we own rather than
 * read out of the queue's internals (ADR-0017). `started` is written before the work
 * begins, so an attempt that never reaches an end state is visible as exactly that — a
 * worker that died mid-job — which a "record the outcome afterwards" design cannot show.
 */
export const jobAttemptStatus = pgEnum('job_attempt_status', ['started', 'completed', 'failed'])
