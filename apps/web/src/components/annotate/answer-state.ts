import { ANNOTATION_NOTE_MAX_LENGTH, type AnnotationOutcome } from '@labelloop/contracts'

/**
 * The annotation session's RULES, with no React in them (ADR-0066).
 *
 * Two things are pure and worth testing on their own: which key means which answer, and when
 * Save is allowed. Both are mirrors of the server — the API refuses a `not_acceptable` with no
 * note and a `skipped` carrying one, and this is what stops a person discovering that by
 * being refused. The screen never becomes the authority; it agrees with one.
 */

export type Answer = AnnotationOutcome | null

/**
 * Y / N / S, and Enter to save (r6 decision 8: twenty items should never need the mouse).
 *
 * Any modifier means this is not our keystroke — Cmd+N opens a window, Ctrl+S saves a page —
 * so the map returns nothing rather than stealing it. Typing in the note is excluded by the
 * caller, not here: the rule is about the event, not about where the focus is.
 */
export const keyToAction = (event: {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): Answer | 'save' | null => {
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return null
  switch (event.key.toLowerCase()) {
    case 'y':
      return 'acceptable'
    case 'n':
      return 'not_acceptable'
    case 's':
      return 'skipped'
    case 'enter':
      return 'save'
    default:
      return null
  }
}

/** Whether the note field is shown at all: only "not acceptable" asks for one. */
export const noteRequired = (answer: Answer): boolean => answer === 'not_acceptable'

/**
 * Whether this answer can be saved yet.
 *
 * `not_acceptable` needs a note with something in it — whitespace is not a reason — and it
 * must be within the cap, which the textarea also enforces with `maxLength`; a paste can
 * exceed that in some browsers, so it is checked rather than assumed.
 */
export const canSave = (answer: Answer, note: string): boolean => {
  if (answer === null) return false
  if (note.length > ANNOTATION_NOTE_MAX_LENGTH) return false
  return answer === 'not_acceptable' ? note.trim() !== '' : true
}

/**
 * What to send. A skip carries no note even if one was typed before the answer changed, and
 * an empty note is omitted rather than sent as an empty string.
 */
export const answerBody = (
  itemId: string,
  answer: Exclude<Answer, null>,
  note: string,
): { item_id: string; outcome: AnnotationOutcome; note?: string } => {
  const trimmed = note.trim()
  if (answer === 'skipped' || trimmed === '') return { item_id: itemId, outcome: answer }
  return { item_id: itemId, outcome: answer, note: trimmed }
}
