import { z } from '@hono/zod-openapi'

/**
 * Prefixed ULIDs (CONVENTIONS.md "API rules"): greppable, sortable, self-describing.
 *
 * A ULID is 26 Crockford-base32 characters — 10 encoding a 48-bit millisecond timestamp
 * followed by 16 encoding 80 bits of randomness — so ids issued in timestamp order also
 * sort in lexicographic order. Hand-rolled rather than pulled in: it is fifty lines of
 * encoding with no architectural weight (CONVENTIONS.md "Dependency threshold").
 */

export const ID_PREFIXES = ['cls_', 'clv_', 'tr_', 'ann_', 'key_', 'jud_', 'ds_', 'ft_'] as const

export type IdPrefix = (typeof ID_PREFIXES)[number]

/** Crockford base32: the decimal digits plus the alphabet without I, L, O and U. */
export const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const TIME_CHARS = 10
const RANDOM_CHARS = 16
export const ULID_CHARS = TIME_CHARS + RANDOM_CHARS

/** 48 bits of milliseconds — the largest instant a ULID timestamp can express. */
export const ULID_MAX_TIME_MS = 2 ** 48 - 1

/** Matches the Crockford alphabet exactly; asserted against it in the tests. */
const ULID_BODY = '[0-9A-HJKMNP-TV-Z]'

export const idPattern = (prefix: IdPrefix): RegExp =>
  new RegExp(`^${prefix}${ULID_BODY}{${ULID_CHARS}}$`)

const encodeBase32 = (value: number, chars: number): string => {
  let out = ''
  let rest = value
  for (let i = 0; i < chars; i++) {
    out = CROCKFORD_ALPHABET.charAt(rest % 32) + out
    rest = Math.floor(rest / 32)
  }
  return out
}

const decodeBase32 = (encoded: string): number => {
  let out = 0
  for (const char of encoded) {
    const digit = CROCKFORD_ALPHABET.indexOf(char)
    if (digit < 0) throw new TypeError(`not a Crockford base32 character: ${char}`)
    out = out * 32 + digit
  }
  return out
}

const randomBase32 = (chars: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(chars))
  let out = ''
  // Five uniform low bits per byte: uniform over the 32-character alphabet.
  for (const byte of bytes) out += CROCKFORD_ALPHABET.charAt(byte & 31)
  return out
}

/**
 * A Zod schema for one id prefix. Branded, so a `cls_` id cannot be passed where a
 * `tr_` id is expected, and OpenAPI-describable so the published spec shows the shape.
 */
export const idSchema = <P extends IdPrefix>(prefix: P, description?: string) =>
  z
    .string()
    .regex(idPattern(prefix), `must be a ${prefix} id (prefix + 26-character ULID)`)
    .openapi({
      description: description ?? `A prefixed ULID identifying a ${prefix} resource.`,
      example: `${prefix}01ARZ3NDEKTSV4RRFFQ69G5FAV`,
    })
    .brand<P>()

export type PrefixedId<P extends IdPrefix> = z.infer<ReturnType<typeof idSchema<P>>>

export type ClassifierId = PrefixedId<'cls_'>
export type ClassifierVersionId = PrefixedId<'clv_'>
export type TraceId = PrefixedId<'tr_'>
export type AnnotationId = PrefixedId<'ann_'>
export type ApiKeyId = PrefixedId<'key_'>
export type JudgeId = PrefixedId<'jud_'>
export type DatasetId = PrefixedId<'ds_'>
export type FineTuneId = PrefixedId<'ft_'>

/** Mint a new id. `now` is injectable so tests (and the `Clock` port) stay deterministic. */
export const newId = <P extends IdPrefix>(prefix: P, now: number = Date.now()): PrefixedId<P> => {
  if (!Number.isInteger(now) || now < 0 || now > ULID_MAX_TIME_MS) {
    throw new RangeError(`timestamp out of ULID range: ${now}`)
  }
  // The one place a branded id comes into existence, so the assertion is the branding.
  return `${prefix}${encodeBase32(now, TIME_CHARS)}${randomBase32(RANDOM_CHARS)}` as PrefixedId<P>
}

export const isId = <P extends IdPrefix>(prefix: P, value: unknown): value is PrefixedId<P> =>
  typeof value === 'string' && idPattern(prefix).test(value)

/** Narrow an untrusted string to a branded id, throwing if the prefix or body is wrong. */
export const parseId = <P extends IdPrefix>(prefix: P, value: unknown): PrefixedId<P> => {
  if (!isId(prefix, value)) {
    throw new TypeError(`expected a ${prefix} id, received: ${String(value)}`)
  }
  return value
}

/** The millisecond timestamp encoded in an id, for assertions and debugging. */
export const idTimestamp = (id: string): number => {
  const underscore = id.indexOf('_')
  const body = id.slice(underscore + 1)
  if (body.length !== ULID_CHARS) throw new TypeError(`not a prefixed ULID: ${id}`)
  return decodeBase32(body.slice(0, TIME_CHARS))
}
