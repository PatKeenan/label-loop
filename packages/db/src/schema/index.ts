/**
 * The whole schema, in one object. This is what `drizzle-kit` diffs to generate a
 * migration and what the Drizzle client is typed against — so a table that is not
 * re-exported here does not exist as far as either is concerned.
 *
 * `relations.ts` is part of that: without it `db.query.<table>` still exists and a plain
 * `findMany()` still works, so the query API looks wired right up until the first `with:`
 * fails at runtime.
 */

export * from './api-keys.ts'
export * from './audit-events.ts'
export * from './auth.ts'
export * from './columns.ts'
export * from './judge-versions.ts'
export * from './judges.ts'
export * from './org-members.ts'
export * from './orgs.ts'
export * from './panel-version-judges.ts'
export * from './panel-versions.ts'
export * from './panels.ts'
export * from './relations.ts'
export * from './trace-verdicts.ts'
export * from './traces.ts'
