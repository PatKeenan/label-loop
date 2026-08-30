# ADR-0031: The Drizzle driver is `node-postgres`, not `bun-sql`

**Status:** Accepted · **Date:** 2026-08-30 · **Milestone:** M1

## Decision
`packages/db` connects through **`drizzle-orm/node-postgres`** over a `pg.Pool`. Bun's
native `SQL` driver is removed from every production path.

A thin `sql-client.ts` preserves the tagged-template surface the repo already reads SQL in
— template, escaped identifier, `unsafe`, `close`, plus the pool Drizzle is handed. The
hand-written `jsonbColumn` custom type is **deleted**, replaced by Drizzle's stock `jsonb()`.

Recorded as STACK_DECISIONS **D3** (amended). Stakeholder decision, 2026-08-30.

## Context
The previous choice was recorded in `client.ts` as *"the driver is the runtime rather than
a dependency, which is one less thing in a tree the CI supply-chain scan has to reason
about."* Two things retired it.

**The saving was already spent.** `pg@^8.23.0` is in the tree transitively via pg-boss, so
it is installed and scanned regardless; `drizzle-orm/node-postgres` added no new package to
the lockfile beyond promoting `pg` to a direct dependency of `packages/db`.

**The pairing produced the same defect twice in one afternoon.** Drizzle's `jsonb()`
stringifies on the way to the driver and Bun's `SQL` serializes objects itself, so the two
compose into a double encoding: Postgres stores a jsonb *string*, and Drizzle parses it
back on read, so every round-trip assertion passes. It is visible only from `psql`.

- The first occurrence was caught at M0 and worked around with a pass-through `jsonbColumn`.
- The second was caught at M1-P4, in the brand-new `model_pin`, written by someone who had
  just re-read the warning while documenting it. `${JSON.stringify(pin)}::jsonb` stored a
  string; nothing complained, because the CHECK only asks whether the column is null. It
  would have surfaced at M4 as a picker unable to read back the pin it had just written.

That recurrence is the argument. A defect a careful reader reproduces immediately after
reading the warning is not a mistake, it is a shape of code that invites the mistake.

**Measured, not assumed.** Both spellings were probed against a real database:

| Binding | `bun-sql` | `node-postgres` |
|---|---|---|
| object param + `::jsonb` | object | object |
| `JSON.stringify(...)` + `::jsonb` | **string** | object |

Under `pg` the bug is unrepresentable — both spellings are correct — which is a stronger
property than fixing the two known occurrences.

### Alternatives considered
**Keep Bun's driver and add a lint rule or a helper.** Cheapest, and it treats a footgun as
a discipline problem. Rejected on the evidence above: the discipline had just failed under
ideal conditions.

**`postgres.js` (`drizzle-orm/postgres-js`).** Its tagged-template API is closest to Bun's,
so it would have needed no shim. Rejected because it is a genuinely new dependency where
`pg` is already present, and it is less battle-tested than `pg`.

**Rewrite all ~65 tagged-template call sites to `pool.query(text, values)`.** The honest
"no new abstraction" option. Rejected because most of those sites are the database tests
that are the safety net for this change: it would put the risk in sixty-five hand edits to
the very assertions meant to catch a mistake, rather than in one file with its own tests.

## Consequences
- **`jsonbColumn` is now a one-line alias for Drizzle's `jsonb().$type<T>()`.** The
  workaround did not merely become unnecessary — under `pg` it became a *bug*: a
  pass-through hands the driver a raw JS array, which `pg` serializes as a Postgres array
  literal `{a,b}` that a jsonb column rejects outright. That is how it was found.
- **SQLSTATE moved from `.errno` to `.code`.** `errnoOf` is renamed `sqlStateOf`; ~34
  assertions across seven test files read it.
- **Queries are eager rather than lazy.** Bun's template did not execute until awaited,
  which is why `expect(query).rejects` hung forever and why `constraints.test.ts` grew its
  own `rejection()` helper. The ordinary matcher works now.
- **`sql-client.ts` is a seam that must stay small.** It is not a query builder and not an
  abstraction over Postgres. `buildQuery` is exported solely so the injection guard asserts
  on generated text rather than inferring safety from behaviour; identifiers are inlined
  and quoted, everything else is `$n`, and placeholder numbering follows the parameter's
  position rather than the expression's.
- **ADR-0004's portability claim is stronger.** *"If Bun misbehaves in production, swap the
  entrypoint; app code survives"* no longer carries an exception: no production file
  imports `SQL` from `bun`.
- One direct dependency added to `packages/db` (`pg`, plus `@types/pg`).

**Verified end to end** on a database rebuilt from `0000`: all five jsonb columns store
objects/arrays and are addressable in SQL; `cost_usd` still reads back as the exact decimal
`0.0000000000` at scale 10; the app/migrator privilege split still rejects DDL from the app
role; migrations, seed and a live panel evaluation all pass. 533 tests, 0 failures.

Log: `thoughts/shared/progress/decisions-log.md` (2026-08-30)
Register: STACK_DECISIONS D3 (amended) · Related: ADR-0004, ADR-0006, ADR-0027
