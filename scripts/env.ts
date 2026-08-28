/**
 * Environment access for the operational scripts. The API validates its own config with a
 * Zod schema at boot (`apps/api/src/config.ts`); these scripts need three connection
 * strings and nothing else, so they get a helper rather than a second schema — but they
 * keep the same rule: fail loudly, naming the field, rather than proceeding on undefined.
 */
export const requireEnv = (name: string): string => {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`Missing ${name}. Copy .env.example to .env, or export it.`)
    process.exit(1)
  }
  return value
}

/** Same rule, but for a value the environment is allowed to omit. */
export const envOr = (name: string, fallback: string): string => {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}
