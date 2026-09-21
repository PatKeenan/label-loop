import { ANNOTATION_FLOOR, type AnnotationOutcome, newId } from '@labelloop/contracts'
import { type Database, schema } from '@labelloop/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import { recordAuditEvent } from '../repositories/audit-events.ts'

/**
 * THE ANNOTATION QUEUE (ADR-0066, ADR-0061, ADR-0067): which trace an annotator sees next, and
 * what happens to their answer.
 *
 * Three rules, and they are the whole design:
 *
 * 1. **A panel is locked below `ANNOTATION_FLOOR` traces.** Judges are authored from what an
 *    expert found in real traffic, and 50 is the point at which reading them is worth someone's
 *    afternoon. Enforced here rather than in the console, so a locked panel cannot be annotated
 *    by anyone holding a cookie and a URL.
 * 2. **One person per trace at M5** (plan decision 7). A trace that ANYBODY has answered
 *    (`acceptable` or `not_acceptable`) leaves the queue for everyone. Agreement between two
 *    annotators is M6's question and needs a second pass built for it; serving the same trace
 *    twice now would produce rows that look like agreement data and are not.
 * 3. **A SKIP frees the trace for someone else, but never comes back to the skipper.** A skip
 *    means "I cannot judge this", which is a fact about the pairing of person and trace, not
 *    about the trace.
 *
 * The item the annotator holds is addressed by the TRACE id, and the payload never contains it
 * (ADR-0067) — see `annotate.ts` for what crosses the wire.
 */

/** The sampler this queue is, recorded on every row it produces (ADR-0066). */
export const SAMPLER = 'random'

export type QueuePanel = {
  panelId: string
  slug: string
  name: string
  traceCount: number
  /** Whether the floor is met — the console draws progress toward it either way. */
  open: boolean
  /** How many traces are still answerable BY THIS PERSON. Zero while locked. */
  remaining: number
  /** How many this person has annotated here, across every visit — not this session's count. */
  annotated: number
}

/**
 * Every panel in the org, with this annotator's standing in each.
 *
 * Annotators cannot read `GET /internal/panels` — a panel's judges, keys and versions are not
 * theirs (ADR-0064) — so this is the minimum the annotator surface needs: a name to choose, a
 * count to see progress toward the gate, and how much is left to do.
 */
export const listAnnotationPanels = async (
  db: Database,
  { orgId, annotatorId }: { orgId: string; annotatorId: string },
): Promise<QueuePanel[]> => {
  const rows = await db
    .select({
      panelId: schema.panels.id,
      slug: schema.panels.slug,
      name: schema.panels.name,
      // QUALIFIED BY HAND, both of them. A Drizzle column inside a `sql` template renders
      // UNQUALIFIED — `"id"` — and inside these subqueries that binds to `traces.id`, making
      // the correlation `traces.panel_id = traces.id`: always false, every count zero, no
      // error anywhere. The same trap Deviation 60 fell into on the trace list.
      traceCount: sql<number>`(
        SELECT count(*)::int FROM traces WHERE traces.panel_id = "panels"."id"
      )`,
      remaining: sql<number>`(
        SELECT count(*)::int FROM traces
        WHERE traces.panel_id = "panels"."id"
          AND ${answerableWhere(annotatorId)}
      )`,
      annotated: sql<number>`(
        SELECT count(*)::int FROM annotations
        WHERE annotations.panel_id = "panels"."id"
          AND annotations.annotator_id = ${annotatorId}
          AND annotations.outcome <> 'skipped'
      )`,
    })
    .from(schema.panels)
    .where(eq(schema.panels.orgId, orgId))
    .orderBy(schema.panels.name)

  return rows.map((row) => {
    const open = row.traceCount >= ANNOTATION_FLOOR
    return { ...row, open, remaining: open ? row.remaining : 0 }
  })
}

/**
 * How many this person has ANNOTATED in this panel — for good, not for this visit.
 *
 * Skips are excluded: a skip is an answer we store ("I cannot judge this") but it is not
 * an annotation of the trace, and counting it would let someone run the counter up by
 * pressing S.
 */
const annotatedWhere = (panelId: string, annotatorId: string) => sql`(
  SELECT count(*)::int FROM annotations
  WHERE annotations.panel_id = ${panelId}
    AND annotations.annotator_id = ${annotatorId}
    AND annotations.outcome <> 'skipped'
)`

/**
 * The two rules that decide whether a trace is still answerable by this person, as one SQL
 * fragment — written once because the COUNT and the PICK must agree. A queue that reported
 * "12 left" and then served nothing would be a bug nobody could see from either query alone.
 */
const answerableWhere = (annotatorId: string) => sql`
  NOT EXISTS (
    SELECT 1 FROM annotations
    WHERE annotations.trace_id = traces.id
      AND annotations.outcome <> 'skipped'
  )
  AND NOT EXISTS (
    SELECT 1 FROM annotations
    WHERE annotations.trace_id = traces.id
      AND annotations.annotator_id = ${annotatorId}
  )
`

export type QueueItem = {
  traceId: string
  panelId: string
  panelVersionId: string
  input: unknown
  output: unknown
  reference: unknown
  /** What is left AFTER this one, so the surface can say "44 left" honestly. */
  remaining: number
  /** Annotated by this person in this panel, ever. Survives leaving and coming back. */
  annotated: number
}

export type NextResult =
  | { state: 'locked'; traceCount: number }
  /** `annotated` rides along so the finished screen can say what the visit was worth. */
  | { state: 'drained'; annotated: number }
  | { state: 'item'; item: QueueItem }

/**
 * The next item for (panel, annotator), or why there is none.
 *
 * **`metadata` is not selected at all** (ADR-0077, ADR-0067). It can carry a customer id, and
 * what the query never reads, no route can leak. `input` is nullable for a trace recorded
 * before the four roles existed (ADR-0074); the surface says so rather than drawing an empty
 * block, and the trace stays answerable, because "is this output acceptable" needs the output.
 */
export const nextItem = async (
  db: Database,
  { orgId, panelSlug, annotatorId }: { orgId: string; panelSlug: string; annotatorId: string },
): Promise<NextResult | null> => {
  const [panel] = await db
    .select({
      id: schema.panels.id,
      traceCount: sql<number>`(
        SELECT count(*)::int FROM traces WHERE traces.panel_id = "panels"."id"
      )`,
    })
    .from(schema.panels)
    .where(and(eq(schema.panels.orgId, orgId), eq(schema.panels.slug, panelSlug)))
    .limit(1)
  // A panel in another org is indistinguishable from one that does not exist (ADR-0057).
  if (panel === undefined) return null
  if (panel.traceCount < ANNOTATION_FLOOR) {
    return { state: 'locked', traceCount: panel.traceCount }
  }

  const rows = await db
    .select({
      traceId: schema.traces.id,
      panelId: schema.traces.panelId,
      panelVersionId: schema.traces.panelVersionId,
      input: schema.traces.input,
      output: schema.traces.output,
      reference: schema.traces.reference,
      remaining: sql<number>`(
        SELECT count(*)::int FROM traces
        WHERE traces.panel_id = ${panel.id}
          AND ${answerableWhere(annotatorId)}
      )`,
      annotated: annotatedWhere(panel.id, annotatorId).mapWith(Number),
    })
    .from(schema.traces)
    .where(and(eq(schema.traces.panelId, panel.id), answerableWhere(annotatorId)))
    // RANDOM, per ADR-0066: the alternative — oldest first — hands one person a solid block of
    // the same week's traffic, which is the worst possible sample to build a taxonomy from.
    .orderBy(sql`random()`)
    .limit(1)

  const item = rows[0]
  if (item === undefined) {
    const [counted] = await db
      .select({ annotated: annotatedWhere(panel.id, annotatorId).mapWith(Number) })
      .from(schema.panels)
      .where(eq(schema.panels.id, panel.id))
      .limit(1)
    return { state: 'drained', annotated: counted?.annotated ?? 0 }
  }
  // `remaining` is computed before this answer exists, so the count the annotator sees next to
  // the item INCLUDES it. Subtracting here is what makes "44 left" mean "after this one".
  return { state: 'item', item: { ...item, remaining: Math.max(0, item.remaining - 1) } }
}

/**
 * THE LAST THING THIS PERSON ANSWERED HERE, served back so it can be answered again — the
 * one step back (stakeholder, 2026-09-20).
 *
 * It is an UNDO of the answer, not of the row: the table is append-only, so answering again
 * writes a second row and the first stays. "What does this person think of this trace" is
 * therefore the LATEST row for the pair, which is what M6 must read — the sequence is the
 * evidence, and an edit in place would destroy the change of mind rather than record it.
 *
 * A skip counts as a last answer. Skipping is how a person parks something they cannot judge,
 * and "actually, I can" is exactly the case this exists for.
 *
 * `null` when the panel is not this org's, or when there is nothing behind you yet.
 */
export const previousItem = async (
  db: Database,
  { orgId, panelSlug, annotatorId }: { orgId: string; panelSlug: string; annotatorId: string },
): Promise<{ item: QueueItem; previousOutcome: AnnotationOutcome } | null> => {
  const [panel] = await db
    .select({ id: schema.panels.id })
    .from(schema.panels)
    .where(and(eq(schema.panels.orgId, orgId), eq(schema.panels.slug, panelSlug)))
    .limit(1)
  if (panel === undefined) return null

  const [row] = await db
    .select({
      traceId: schema.traces.id,
      panelId: schema.traces.panelId,
      panelVersionId: schema.traces.panelVersionId,
      input: schema.traces.input,
      output: schema.traces.output,
      reference: schema.traces.reference,
      previousOutcome: schema.annotations.outcome,
      remaining: sql<number>`(
        SELECT count(*)::int FROM traces
        WHERE traces.panel_id = ${panel.id}
          AND ${answerableWhere(annotatorId)}
      )`,
      annotated: annotatedWhere(panel.id, annotatorId).mapWith(Number),
    })
    .from(schema.annotations)
    .innerJoin(schema.traces, eq(schema.traces.id, schema.annotations.traceId))
    .where(
      and(
        eq(schema.annotations.panelId, panel.id),
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

export type AnnotationWrite = {
  orgId: string
  annotatorId: string
  requestId: string
  traceId: string
  outcome: AnnotationOutcome
  note?: string | undefined
}

/**
 * Record one answer, with its audit event, in one transaction (ADR-0051).
 *
 * The panel and its VERSION are copied from the trace inside that transaction rather than
 * taken from the client: the answer is about the configuration that produced the trace, and a
 * caller cannot be trusted to say which that was (ADR-0003).
 *
 * The audit event carries ids and the outcome, **never the note** — the log is append-only and
 * cannot be scrubbed, and a note is free text an annotator may have put a customer's words in.
 */
export const recordAnnotation = async (
  db: Database,
  write: AnnotationWrite,
): Promise<{ ok: true; annotationId: string } | { ok: false }> => {
  const [trace] = await db
    .select({ panelId: schema.traces.panelId, panelVersionId: schema.traces.panelVersionId })
    .from(schema.traces)
    .where(and(eq(schema.traces.orgId, write.orgId), eq(schema.traces.id, write.traceId)))
    .limit(1)
  if (trace === undefined) return { ok: false }

  const annotationId = newId('ann_')
  await db.transaction(async (tx) => {
    await tx.insert(schema.annotations).values({
      id: annotationId,
      orgId: write.orgId,
      traceId: write.traceId,
      panelId: trace.panelId,
      panelVersionId: trace.panelVersionId,
      annotatorId: write.annotatorId,
      outcome: write.outcome,
      note: write.outcome === 'skipped' ? null : (write.note?.trim() ?? null),
      sampler: SAMPLER,
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
        panel_version_id: trace.panelVersionId,
        outcome: write.outcome,
        sampler: SAMPLER,
        // Whether a note exists is auditable; its words are not.
        has_note: write.outcome !== 'skipped' && (write.note?.trim() ?? '') !== '',
      },
      requestId: write.requestId,
    })
  })
  return { ok: true, annotationId }
}
