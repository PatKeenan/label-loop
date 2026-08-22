/**
 * `@labelloop/contracts` — the single source of type truth (CONVENTIONS.md "Repo shape").
 * No endpoint ships without a contract here; `apps/api`, `apps/web` and anything that
 * follows import from this entry point rather than restating shapes.
 */

export * from './classify.ts'
export * from './envelope.ts'
export * from './errors.ts'
export * from './ids.ts'
