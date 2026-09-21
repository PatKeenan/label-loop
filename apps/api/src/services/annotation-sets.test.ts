import { describe, expect, test } from 'bun:test'
import { countingAnswer } from './annotation-sets.ts'

/**
 * THE DICTATOR RULE, on its own (ADR-0081). It is a rule for READING rows, so it is a pure
 * function over rows, and this file needs no database to hold it to account.
 *
 * The integration tests prove the rows arrive; this proves what they MEAN once they have.
 */

const at = (minutes: number) => new Date(Date.parse('2026-09-21T12:00:00Z') + minutes * 60_000)

const row = (annotatorId: string, outcome: string, minutes: number, id = `ann_${minutes}`) => ({
  annotatorId,
  outcome,
  createdAt: at(minutes),
  id,
})

const DICTATOR = 'user_maya'
const OTHER = 'user_sam'

describe('where answers differ, the dictator’s counts', () => {
  test('nobody has answered: there is nothing to report', () => {
    expect(countingAnswer([], DICTATOR)).toBeNull()
  })

  test('everybody agrees: that answer, whoever the dictator is', () => {
    const rows = [row(OTHER, 'acceptable', 1), row(DICTATOR, 'acceptable', 2)]
    expect(countingAnswer(rows, DICTATOR)?.outcome).toBe('acceptable')
    // Agreement needs no tie-break, so it holds with no dictator named at all.
    expect(countingAnswer(rows, null)?.outcome).toBe('acceptable')
  })

  test('they differ: the dictator’s, and it is named as theirs', () => {
    const rows = [row(OTHER, 'acceptable', 1), row(DICTATOR, 'not_acceptable', 2)]
    expect(countingAnswer(rows, DICTATOR)).toEqual({
      outcome: 'not_acceptable',
      annotatorId: DICTATOR,
    })
  })

  test('they differ and the DICTATOR has not answered: null, not a guess', () => {
    // Reporting one anyway would invent a decision nobody made. There is genuinely no
    // tie-break yet, and saying so is the honest answer.
    const rows = [row(OTHER, 'acceptable', 1), row('user_third', 'not_acceptable', 2)]
    expect(countingAnswer(rows, DICTATOR)).toBeNull()
    // And with no dictator at all — the case ADR-0081 refuses to let a set reach with two
    // assigned annotators, which this function still has to answer for one-person sets.
    expect(countingAnswer(rows, null)).toBeNull()
  })

  test('the LATEST row per person, because a changed mind is a new row', () => {
    const rows = [
      row(DICTATOR, 'acceptable', 1),
      row(OTHER, 'not_acceptable', 2),
      // Their second thought. The first is history, not a second opinion.
      row(DICTATOR, 'not_acceptable', 3),
    ]
    expect(countingAnswer(rows, DICTATOR)?.outcome).toBe('not_acceptable')
  })

  test('two answers in the same millisecond are ordered by id', () => {
    // `ann_` is a ULID, so it sorts by time and then by randomness — two saves in one tick
    // still have an order, and it is the one the database would return.
    const rows = [
      row(DICTATOR, 'acceptable', 5, 'ann_01AAAA'),
      row(DICTATOR, 'not_acceptable', 5, 'ann_01BBBB'),
      row(OTHER, 'acceptable', 4),
    ]
    expect(countingAnswer(rows, DICTATOR)?.outcome).toBe('not_acceptable')
  })

  test('a skip is an answer like any other here', () => {
    // It is what the person said, and where it disagrees with somebody the dictator still
    // settles it. Whether a skip COUNTS toward progress is a different question (`setProgress`).
    const rows = [row(OTHER, 'acceptable', 1), row(DICTATOR, 'skipped', 2)]
    expect(countingAnswer(rows, DICTATOR)?.outcome).toBe('skipped')
  })

  test('one person, one answer: theirs, with no dictator needed', () => {
    expect(countingAnswer([row(OTHER, 'acceptable', 1)], null)).toEqual({
      outcome: 'acceptable',
      annotatorId: OTHER,
    })
  })
})
