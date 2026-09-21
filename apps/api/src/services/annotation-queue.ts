import { ANNOTATION_FLOOR, type AnnotationOutcome, newId } from '@labelloop/contracts'
import { type Database, schema } from '@labelloop/db'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { recordAuditEvent } from '../repositories/audit-events.ts'
import type { Executor } from '../repositories/executor.ts'

/**
 * THE ANNOTATION QUEUE (ADR-0079, ADR-0081, ADR-0061, ADR-0067): which trace an annotator sees
 * next, and what happens to their answer.
 *
 * Four rules, and they are the whole design:
 *
 * 1. **The pool is an ASSIGNED SET, never a panel** (ADR-0079). A set they are not assigned to
 *    answers NOT_FOUND, exactly as another org's does, and an annotator with nothing assigned
 *    has nothing to do. There is no default set and no bootstrap path: work exists because
 *    somebody decided it was worth an afternoon.
 * 2. **A trace leaves YOUR queue when YOU have answered it** (ADR-0081, superseding ADR-0066's
 *    one-person-per-trace). Everyone assigned annotates the whole set, so the overlap is simply
 *    how many people were assigned — there is no overlap number to configure, and recording
 *    overlaps is the raw material M6's agreement metrics are computed from.
 * 3. **A SKIP is an answer for this purpose.** "I cannot judge this" is a fact about the pairing
 *    of person and trace, so it never comes back to the skipper — but it does not count as an
 *    ANNOTATION in the number they are shown, or pressing S would run the counter up.
 * 4. **A panel is still locked below `ANNOTATION_FLOOR` traces** (ADR-0061). Enforced here
 *    rather than in the console, so a locked panel cannot be annotated by anyone holding a
 *    cookie and a URL.
 *
 * **An annotator never sees another annotator's answer** — ADR-0067's reasoning pointed at
 * people rather than at a judge: knowing what somebody else said is the strongest anchor there
 * is, and agreement measured after it is not agreement. The item is addressed by the TRACE id
 * and the payload never contains it; see `annotate.ts` for what crosses the wire.
 */

// ── What one person has answered, and what is left ────────────────────────────────────────

/**
 * ANNOTATED excludes skips — it is what the surface shows a person, because a skip is an answer
 * we store and not an annotation of the trace. ANSWERED (below, inline in each query) includes
 * them, because a skip is what empties that trace out of their queue.
 *
 * Two counts, deliberately, and they are not interchangeable: `annotated` is what somebody did,
 * `answered` is what is left to do.
 */
const annotatedWhere = (setId: string, annotatorId: string) => sql`(
  SELECT count(DISTINCT annotations.trace_id)::int FROM annotations
  WHERE annotations.annotation_set_id = ${setId}
    AND annotations.annotator_id = ${annotatorId}
    AND annotations.outcome <> 'skipped'
)`

/**
 * How many of the set's traces this person has not answered. Correlated against
 * `annotation_set_traces`, which IS the pool — `traces` is joined for its content, never for
 * its membership.
 *
 * Written once because the COUNT and the PICK have to agree. A queue reporting "12 left" and
 * then serving nothing would be a bug invisible from either query alone.
 */
const remainingWhere = (setId: string, annotatorId: string) => sql`(
  SELECT count(*)::int FROM annotation_set_traces
  WHERE annotation_set_traces.annotation_set_id = ${setId}
    AND NOT EXISTS (
      SELECT 1 FROM annotations
      WHERE annotations.trace_id = annotation_set_traces.trace_id
        AND annotations.annotation_set_id = ${setId}
        AND annotations.annotator_id = ${annotatorId}
    )
)`

/** Rule 2 as a predicate on the row being considered. */
const unansweredByMe = (setId: string, annotatorId: string) => sql`
  NOT EXISTS (
    SELECT 1 FROM annotations
    WHERE annotations.trace_id = "annotation_set_traces"."trace_id"
      AND annotations.annotation_set_id = ${setId}
      AND annotations.annotator_id = ${annotatorId}
  )
`

// ── The sets assigned to one person ───────────────────────────────────────────────────────

export type AssignedSet = {
  setId: string
  /** The set's NAME reaches the annotator. Its strategy does not — that is an operator signal. */
  name: string
  panelName: string
  traceCount: number
  /** Whether the panel's floor is met. The surface draws progress toward it either way. */
  open: boolean
  size: number
  /** How many of the set's traces are still answerable BY THIS PERSON. Zero while locked. */
  remaining: number
  /** How many this person has annotated here, across every visit — not this session's count. */
  annotated: number
}

/**
 * THE SETS ASSIGNED TO THIS PERSON, and nothing else (ADR-0079).
 *
 * Annotators cannot read `GET /internal/panels` — a panel's judges, keys and versions are not
 * theirs (ADR-0064) — and they cannot read a set they are not assigned to either. Assignment is
 * the whole of their access, which is also why assigning is an access-granting write (ADR-0083).
 *
 * An UNASSIGNED row is excluded: the work has been taken off them. Their answers stay, and stay
 * visible to staff (ADR-0086), but the set is no longer theirs to open. An ARCHIVED set is
 * excluded for the same reason from the other direction — it has been put away.
 */
export const listAssignedSets = async (
  db: Database,
  { orgId, annotatorId }: { orgId: string; annotatorId: string },
): Promise<AssignedSet[]> => {
  const rows = await db
    .select({
      setId: schema.annotationSets.id,
      name: schema.annotationSets.name,
      panelName: schema.panels.name,
      // QUALIFIED BY HAND, every one of them. A Drizzle column inside a `sql` template renders
      // UNQUALIFIED — `"id"` — which inside a correlated subquery binds to the SUBQUERY's table
      // and makes the correlation always false: every count zero, no error anywhere (M5
      // Deviations 19 and 35, M4 Deviation 60).
      traceCount: sql<number>`(
        SELECT count(*)::int FROM traces WHERE traces.panel_id = "panels"."id"
      )`.mapWith(Number),
      size: sql<number>`(
        SELECT count(*)::int FROM annotation_set_traces
        WHERE annotation_set_traces.annotation_set_id = "annotation_sets"."id"
      )`.mapWith(Number),
      remaining: sql<number>`(
        SELECT count(*)::int FROM annotation_set_traces
        WHERE annotation_set_traces.annotation_set_id = "annotation_sets"."id"
          AND NOT EXISTS (
            SELECT 1 FROM annotations
            WHERE annotations.trace_id = annotation_set_traces.trace_id
              AND annotations.annotation_set_id = "annotation_sets"."id"
              AND annotations.annotator_id = ${annotatorId}
          )
      )`.mapWith(Number),
      annotated: sql<number>`(
        SELECT count(DISTINCT annotations.trace_id)::int FROM annotations
        WHERE annotations.annotation_set_id = "annotation_sets"."id"
          AND annotations.annotator_id = ${annotatorId}
          AND annotations.outcome <> 'skipped'
      )`.mapWith(Number),
    })
    .from(schema.annotationSetAnnotators)
    .innerJoin(
      schema.annotationSets,
      eq(schema.annotationSets.id, schema.annotationSetAnnotators.annotationSetId),
    )
    .innerJoin(schema.panels, eq(schema.panels.id, schema.annotationSets.panelId))
    .where(
      and(
        eq(schema.annotationSetAnnotators.userId, annotatorId),
        isNull(schema.annotationSetAnnotators.unassignedAt),
        eq(schema.annotationSets.orgId, orgId),
        isNull(schema.annotationSets.archivedAt),
      ),
    )
    .orderBy(schema.annotationSets.name)

  return rows.map((row) => {
    const open = row.traceCount >= ANNOTATION_FLOOR
    return { ...row, open, remaining: open ? row.remaining : 0 }
  })
}

// ── Progress, and therefore done ──────────────────────────────────────────────────────────

export type AnnotatorProgress = {
  userId: string
  /** Any row, skips included. This is what empties a queue, so this is what decides done. */
  answered: number
  /** Non-skip rows — what a person is shown, and what M6 has material to cluster. */
  annotated: number
}

export type SetProgress = {
  setId: string
  size: number
  /** CURRENTLY assigned only (`unassigned_at IS NULL`) — see `done`. */
  annotators: AnnotatorProgress[]
  done: boolean
}

/**
 * THE ONE DEFINITION OF ANSWERED AND DONE (ADR-0086), used by the annotator's list, by the
 * staff section, and by nothing else. Two screens computing it separately would disagree, and
 * the one that disagreed would be believed.
 *
 * **Done is: every CURRENTLY ASSIGNED annotator has answered every trace.** Three things in
 * that sentence are load-bearing:
 *
 * - **Derived, never stored.** A stamp would go on saying "done" the moment a third annotator
 *   is assigned to a finished set, when the set genuinely is not done any more.
 * - **`unassigned_at IS NULL`.** Read as "every assigned annotator", one unassigned person
 *   would block a set from ever completing, which is the opposite of what unassigning is for.
 *   Their answers stay and stay visible; the set simply stops waiting on them.
 * - **A set with no traces, or with nobody assigned, is NOT done.** Both are vacuously true
 *   under "everyone has answered everything", and both mean a pass that has not happened.
 */
export const setProgress = async (
  db: Executor,
  setIds: readonly string[],
): Promise<Map<string, SetProgress>> => {
  const out = new Map<string, SetProgress>()
  if (setIds.length === 0) return out
  const ids = [...setIds]

  const sizes = await db
    .select({
      setId: schema.annotationSetTraces.annotationSetId,
      size: sql<number>`count(*)::int`.mapWith(Number),
    })
    .from(schema.annotationSetTraces)
    .where(inArray(schema.annotationSetTraces.annotationSetId, ids))
    .groupBy(schema.annotationSetTraces.annotationSetId)

  const people = await db
    .select({
      setId: schema.annotationSetAnnotators.annotationSetId,
      userId: schema.annotationSetAnnotators.userId,
      answered: sql<number>`(
        SELECT count(DISTINCT annotations.trace_id)::int FROM annotations
        WHERE annotations.annotation_set_id = "annotation_set_annotators"."annotation_set_id"
          AND annotations.annotator_id = "annotation_set_annotators"."user_id"
      )`.mapWith(Number),
      annotated: sql<number>`(
        SELECT count(DISTINCT annotations.trace_id)::int FROM annotations
        WHERE annotations.annotation_set_id = "annotation_set_annotators"."annotation_set_id"
          AND annotations.annotator_id = "annotation_set_annotators"."user_id"
          AND annotations.outcome <> 'skipped'
      )`.mapWith(Number),
    })
    .from(schema.annotationSetAnnotators)
    .where(
      and(
        inArray(schema.annotationSetAnnotators.annotationSetId, ids),
        isNull(schema.annotationSetAnnotators.unassignedAt),
      ),
    )

  const sizeOf = new Map(sizes.map((row) => [row.setId, row.size]))
  for (const setId of ids) {
    const size = sizeOf.get(setId) ?? 0
    const annotators = people
      .filter((row) => row.setId === setId)
      .map(({ userId, answered, annotated }) => ({ userId, answered, annotated }))
    out.set(setId, {
      setId,
      size,
      annotators,
      done:
        size > 0 &&
        annotators.length > 0 &&
        annotators.every((annotator) => annotator.answered >= size),
    })
  }
  return out
}

// ── The next item ─────────────────────────────────────────────────────────────────────────

export type QueueItem = {
  traceId: string
  panelId: string
  panelVersionId: string
  input: unknown
  output: unknown
  reference: unknown
  /** What is left AFTER this one, so the surface can say "44 left" honestly. */
  remaining: number
  /** Annotated by this person in this set, ever. Survives leaving and coming back. */
  annotated: number
}

export type NextResult =
  | { state: 'locked'; traceCount: number }
  /** `annotated` rides along so the finished screen can say what the visit was worth. */
  | { state: 'drained'; annotated: number }
  | { state: 'item'; item: QueueItem }

type SetContext = { setId: string; panelId: string; name: string; traceCount: number }

/**
 * The set, IF this person is currently assigned to it. `undefined` otherwise — for a set in
 * another org, an archived one, one that does not exist, and one they are simply not on. The
 * caller cannot tell those apart, which is ADR-0057 applied to work rather than to tenancy.
 */
const assignedSet = async (
  db: Database,
  { orgId, setId, annotatorId }: { orgId: string; setId: string; annotatorId: string },
): Promise<SetContext | undefined> => {
  const [row] = await db
    .select({
      setId: schema.annotationSets.id,
      panelId: schema.annotationSets.panelId,
      name: schema.annotationSets.name,
      traceCount: sql<number>`(
        SELECT count(*)::int FROM traces WHERE traces.panel_id = "annotation_sets"."panel_id"
      )`.mapWith(Number),
    })
    .from(schema.annotationSets)
    .innerJoin(
      schema.annotationSetAnnotators,
      eq(schema.annotationSetAnnotators.annotationSetId, schema.annotationSets.id),
    )
    .where(
      and(
        eq(schema.annotationSets.id, setId),
        eq(schema.annotationSets.orgId, orgId),
        isNull(schema.annotationSets.archivedAt),
        eq(schema.annotationSetAnnotators.userId, annotatorId),
        isNull(schema.annotationSetAnnotators.unassignedAt),
      ),
    )
    .limit(1)
  return row
}

/**
 * The next item for (set, annotator), or why there is none.
 *
 * **`metadata` is not selected at all** (ADR-0077, ADR-0067). It can carry a customer id, and
 * what the query never reads, no route can leak. `input` is nullable for a trace recorded
 * before the four roles existed (ADR-0074); the surface says so rather than drawing an empty
 * block, and the trace stays answerable, because "is this output acceptable" needs the output.
 */
export const nextItem = async (
  db: Database,
  { orgId, setId, annotatorId }: { orgId: string; setId: string; annotatorId: string },
): Promise<NextResult | null> => {
  const set = await assignedSet(db, { orgId, setId, annotatorId })
  if (set === undefined) return null
  if (set.traceCount < ANNOTATION_FLOOR) {
    return { state: 'locked', traceCount: set.traceCount }
  }

  const rows = await db
    .select({
      traceId: schema.traces.id,
      panelId: schema.traces.panelId,
      panelVersionId: schema.traces.panelVersionId,
      input: schema.traces.input,
      output: schema.traces.output,
      reference: schema.traces.reference,
      remaining: remainingWhere(setId, annotatorId).mapWith(Number),
      annotated: annotatedWhere(setId, annotatorId).mapWith(Number),
    })
    .from(schema.annotationSetTraces)
    .innerJoin(schema.traces, eq(schema.traces.id, schema.annotationSetTraces.traceId))
    .where(
      and(
        eq(schema.annotationSetTraces.annotationSetId, setId),
        unansweredByMe(setId, annotatorId),
      ),
    )
    // RANDOM, per ADR-0066: the alternative — oldest first — hands one person a solid block of
    // the same week's traffic, which is the worst possible sample to build a taxonomy from.
    .orderBy(sql`random()`)
    .limit(1)

  const item = rows[0]
  if (item === undefined) {
    const [counted] = await db
      .select({ annotated: annotatedWhere(setId, annotatorId).mapWith(Number) })
      .from(schema.annotationSets)
      .where(eq(schema.annotationSets.id, setId))
      .limit(1)
    return { state: 'drained', annotated: counted?.annotated ?? 0 }
  }
  // `remaining` is computed before this answer exists, so the count the annotator sees next to
  // the item INCLUDES it. Subtracting here is what makes "44 left" mean "after this one".
  return { state: 'item', item: { ...item, remaining: Math.max(0, item.remaining - 1) } }
}

/**
 * THE LAST THING THIS PERSON ANSWERED IN THIS SET, served back so it can be answered again —
 * the one step back (stakeholder, 2026-09-20).
 *
 * It is an UNDO of the answer, not of the row: the table is append-only, so answering again
 * writes a second row and the first stays. "What does this person think of this trace" is
 * therefore the LATEST row for the pair, which is what M6 must read — the sequence is the
 * evidence, and an edit in place would destroy the change of mind rather than record it.
 *
 * A skip counts as a last answer. Skipping is how a person parks something they cannot judge,
 * and "actually, I can" is exactly the case this exists for.
 *
 * **Scoped to the set**, so stepping back never crosses out of the work you are doing.
 */
export const previousItem = async (
  db: Database,
  { orgId, setId, annotatorId }: { orgId: string; setId: string; annotatorId: string },
): Promise<{ item: QueueItem; previousOutcome: AnnotationOutcome } | null> => {
  const set = await assignedSet(db, { orgId, setId, annotatorId })
  if (set === undefined) return null

  const [row] = await db
    .select({
      traceId: schema.traces.id,
      panelId: schema.traces.panelId,
      panelVersionId: schema.traces.panelVersionId,
      input: schema.traces.input,
      output: schema.traces.output,
      reference: schema.traces.reference,
      previousOutcome: schema.annotations.outcome,
      remaining: remainingWhere(setId, annotatorId).mapWith(Number),
      annotated: annotatedWhere(setId, annotatorId).mapWith(Number),
    })
    .from(schema.annotations)
    .innerJoin(schema.traces, eq(schema.traces.id, schema.annotations.traceId))
    .where(
      and(
        eq(schema.annotations.annotationSetId, setId),
        eq(schema.annotations.annotatorId, annotatorId),
      ),
    )
    // The most recent answer, and `id` breaks a tie: `ann_` is a ULID, so it sorts by time
    // within the same millisecond — two answers saved in one tick still have an order.
    .orderBy(desc(schema.annotations.createdAt), desc(schema.annotations.id))
    .limit(1)

  if (row === undefined) return null
  const { previousOutcome, ...item } = row
  return { item, previousOutcome }
}

// ── The write ─────────────────────────────────────────────────────────────────────────────

export type AnnotationWrite = {
  orgId: string
  setId: string
  annotatorId: string
  requestId: string
  traceId: string
  outcome: AnnotationOutcome
  note?: string | undefined
}

/**
 * Record one answer, with its audit event, in one transaction (ADR-0051).
 *
 * **The membership row is what authorises the write, and it is also what names the sampler.**
 * One lookup answers three questions at once: is this person currently assigned to this set, is
 * this trace actually in it, and which picker put it there. `sampler` is that picker rather
 * than the constant `'random'` it was while the queue itself was the sampler — "which strategy
 * found the failures" is unanswerable retroactively otherwise.
 *
 * The panel and its VERSION are copied from the trace inside that transaction rather than taken
 * from the client: the answer is about the configuration that produced the trace, and a caller
 * cannot be trusted to say which that was (ADR-0003).
 *
 * The audit event carries ids and the outcome, **never the note** — the log is append-only and
 * cannot be scrubbed, and a note is free text an annotator may have put a customer's words in.
 */
export const recordAnnotation = async (
  db: Database,
  write: AnnotationWrite,
): Promise<{ ok: true; annotationId: string } | { ok: false }> => {
  const [row] = await db
    .select({
      panelId: schema.traces.panelId,
      panelVersionId: schema.traces.panelVersionId,
      sampler: schema.annotationSetTraces.strategy,
    })
    .from(schema.annotationSetTraces)
    .innerJoin(schema.traces, eq(schema.traces.id, schema.annotationSetTraces.traceId))
    .innerJoin(
      schema.annotationSets,
      eq(schema.annotationSets.id, schema.annotationSetTraces.annotationSetId),
    )
    .innerJoin(
      schema.annotationSetAnnotators,
      eq(schema.annotationSetAnnotators.annotationSetId, schema.annotationSets.id),
    )
    .where(
      and(
        eq(schema.annotationSetTraces.annotationSetId, write.setId),
        eq(schema.annotationSetTraces.traceId, write.traceId),
        eq(schema.annotationSets.orgId, write.orgId),
        isNull(schema.annotationSets.archivedAt),
        eq(schema.annotationSetAnnotators.userId, write.annotatorId),
        isNull(schema.annotationSetAnnotators.unassignedAt),
      ),
    )
    .limit(1)
  if (row === undefined) return { ok: false }

  const annotationId = newId('ann_')
  await db.transaction(async (tx) => {
    await tx.insert(schema.annotations).values({
      id: annotationId,
      orgId: write.orgId,
      traceId: write.traceId,
      panelId: row.panelId,
      panelVersionId: row.panelVersionId,
      annotationSetId: write.setId,
      annotatorId: write.annotatorId,
      outcome: write.outcome,
      note: write.outcome === 'skipped' ? null : (write.note?.trim() ?? null),
      sampler: row.sampler,
    })
    await recordAuditEvent(tx, {
      orgId: write.orgId,
      actorType: 'user',
      actorId: write.annotatorId,
      action: 'annotation.created',
      subjectType: 'annotation',
      subjectId: annotationId,
      data: {
        trace_id: write.traceId,
        annotation_set_id: write.setId,
        panel_version_id: row.panelVersionId,
        outcome: write.outcome,
        sampler: row.sampler,
        // Whether a note exists is auditable; its words are not.
        has_note: write.outcome !== 'skipped' && (write.note?.trim() ?? '') !== '',
      },
      requestId: write.requestId,
    })
  })
  return { ok: true, annotationId }
}
