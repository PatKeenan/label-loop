import { describe, expect, test } from 'bun:test'
import {
  CROCKFORD_ALPHABET,
  ID_PREFIXES,
  idPattern,
  idSchema,
  idTimestamp,
  isId,
  newId,
  parseId,
  ULID_CHARS,
  ULID_MAX_TIME_MS,
} from './ids.ts'

describe('prefixed ULIDs', () => {
  test('the prefix set is exactly the one CONVENTIONS names', () => {
    expect([...ID_PREFIXES]).toEqual([
      'pnl_',
      'pnv_',
      'jud_',
      'jdv_',
      'tax_',
      'tr_',
      'ann_',
      'key_',
      'ds_',
      'ft_',
    ])
  })

  test('the body pattern accepts the Crockford alphabet and nothing else', () => {
    const pattern = idPattern('tr_')
    for (const char of CROCKFORD_ALPHABET) {
      expect(pattern.test(`tr_${char.repeat(ULID_CHARS)}`), char).toBe(true)
    }
    // The four characters Crockford drops, plus lower case.
    for (const char of 'ILOUa') {
      expect(pattern.test(`tr_${char.repeat(ULID_CHARS)}`), char).toBe(false)
    }
  })

  test('every prefix mints an id matching its own pattern and no other', () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix)
      expect(isId(prefix, id)).toBe(true)
      for (const other of ID_PREFIXES) {
        if (other !== prefix) expect(isId(other, id)).toBe(false)
      }
    }
  })

  test('round-trips through parseId and back out to its timestamp', () => {
    const now = 1_755_648_000_000
    const id = newId('tr_', now)
    expect(parseId('tr_', id)).toBe(id)
    expect(idTimestamp(id)).toBe(now)
    expect(id).toHaveLength('tr_'.length + ULID_CHARS)
  })

  test('parseId rejects a wrong prefix, a short body, and a non-string', () => {
    const pnv = newId('pnv_')
    expect(() => parseId('pnl_', pnv)).toThrow(/expected a pnl_ id/)
    expect(() => parseId('tr_', 'tr_TOOSHORT')).toThrow(/expected a tr_ id/)
    expect(() => parseId('tr_', undefined)).toThrow(/expected a tr_ id/)
    // pnl_ and pnv_ share three characters, as do jud_ and jdv_: the pattern must not
    // treat one as the other.
    expect(isId('pnl_', pnv)).toBe(false)
    expect(isId('jud_', newId('jdv_'))).toBe(false)
  })

  test('ids sort lexicographically in timestamp order', () => {
    const timestamps = [0, 1, 1_000, 1_755_648_000_000, ULID_MAX_TIME_MS]
    const ids = timestamps.map((ms) => newId('tr_', ms))
    expect([...ids].sort()).toEqual(ids)
    expect(ids.map(idTimestamp)).toEqual(timestamps)
  })

  test('ids minted in the same millisecond differ', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('tr_', 1_755_648_000_000)))
    expect(ids.size).toBe(500)
  })

  test('an out-of-range timestamp is a programming error, not a silent truncation', () => {
    expect(() => newId('tr_', ULID_MAX_TIME_MS + 1)).toThrow(RangeError)
    expect(() => newId('tr_', -1)).toThrow(RangeError)
    expect(() => newId('tr_', 1.5)).toThrow(RangeError)
  })
})

describe('idSchema', () => {
  const schema = idSchema('tr_')

  test('parses a real id and rejects a foreign one with a readable message', () => {
    const id = newId('tr_')
    expect(schema.parse(id)).toBe(id)
    const result = schema.safeParse(newId('pnl_'))
    expect(result.success).toBe(false)
    expect(result.error?.issues[0]?.message).toMatch(/must be a tr_ id/)
  })

  test('the OpenAPI example it advertises is itself a valid id', () => {
    const example = parseId('tr_', 'tr_01ARZ3NDEKTSV4RRFFQ69G5FAV')
    expect(schema.parse(example)).toBe(example)
  })
})
