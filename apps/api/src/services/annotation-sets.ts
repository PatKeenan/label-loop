import {
  ANNOTATION_SET_MAX_SIZE,
  type AnnotationSetPick,
  type AnnotationSetStrategy,
  can,
  newId,
  type OrgRole,
  pickSize,
} from '@labelloop/contracts'
import { type Database, schema } from '@labelloop/db'
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import type { Clock } from '../ports/clock.ts'
import { recordAuditEvent } from '../repositories/audit-events.ts'
import type { Executor } from '../repositories/executor.ts'

/**
 * CURATING AN ANNOTATION SET — creating one, growing it, assigning people to it, putting it
 * away (ADR-0079…0083, ADR-0086).
 *
 * **Every write is one transaction with its audit event** (ADR-0051), and assignment is the
 * one that matters most: assigning somebody a set GRANTS THEM READ ACCESS to those traces'
 * `input`, `output` and `reference` through the annotate queue, in a panel they can otherwise
 * reach nothing of. That is an access-granting write rather than bookkeeping, which is why it
 * is `annotation: ['curate']` (ADR-0083) and why the event records who did it.
 *
 * **No event ever carries trace ids.** The audit log has no UPDATE and no DELETE and M8 adds
 * export on top, so what goes in is permanent; a strategy and a count answer "what pass was
 * this" without copying the selection into a table that can never be trimmed.
 */

type Actor = {
  db: Database
  clock: Clock
  orgId: string
  actorId: string
  requestId: string
}

// ── Resolving a picker ────────────────────────────────────────────────────────────────────

/**
 * WHICH TRACES A PICKER CHOOSES, resolved ONCE (ADR-0080). It is never a stored query.
 *
 * `exclude` is what the set already holds, and it is why a top-up of 25 adds 25 NEW traces
 * rather than re-picking the same ones and appending nothing: the candidate pool is the panel
 * minus the snapshot. A manual pick that names a trace already in the set still adds nothing —
 * the primary key says so — which is the other half of the same guarantee.
 *
 * `manual` REFUSES an id that is not a trace of this panel rather than dropping it silently: an
 * engineer who selected six rows and got four has been told something untrue about their set.
 */
export type ResolveResult =
  | { ok: true; traceIds: string[] }
  | { ok: false; kind: 'unknown_traces'; traceIds: string[] }

export const resolveTraces = async (
  db: Executor,
  {
    panelId,
    pick,
    exclude,
  }: { panelId: string; pick: AnnotationSetPick; exclude: readonly string[] },
): Promise<ResolveResult> => {
  const inPanel = eq(schema.traces.panelId, panelId)
  const notAlreadyIn = exclude.length === 0 ? undefined : notInArray(schema.traces.id, [...exclude])

  if (pick.strategy === 'manual') {
    const asked = [...new Set(pick.trace_ids)]
    const found = await db
      .select({ id: schema.traces.id })
      .from(schema.traces)
      .where(and(inPanel, inArray(schema.traces.id, asked)))
    const known = new Set(found.map((row) => row.id))
    const unknown = asked.filter((traceId) => !known.has(traceId))
    if (unknown.length > 0) return { ok: false, kind: 'unknown_traces', traceIds: unknown }
    // The set's own rows are left in: the insert's ON CONFLICT DO NOTHING drops them, and
    // refusing them would make re-selecting a row in the table an error rather than a no-op.
    return { ok: true, traceIds: asked }
  }

  const order =
    pick.strategy === 'latest_n'
      ? desc(schema.traces.createdAt)
      : pick.strategy === 'earliest_n'
        ? asc(schema.traces.createdAt)
        : // `random()` is resolved here and written down, which is the whole point of a
          // snapshot: the same set read twice is the same traces.
          sql`random()`

  const rows = await db
    .select({ id: schema.traces.id })
    .from(schema.traces)
    .where(and(inPanel, notAlreadyIn))
    .orderBy(order)
    .limit(pick.size)

  return { ok: true, traceIds: rows.map((row) => row.id) }
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────

export type AnnotationSetRow = {
  id: string
  name: string
  createdAt: Date
  archivedAt: Date | null
  createdByEmail: string
  size: number
}

/**
 * A panel's sets, newest first. Size is counted rather than cached — see the schema's note on
 * why there is no count column.
 *
 * Archived sets are returned with their stamp rather than filtered here: the console's filter
 * is a view over one list, and an archive the server hides is a delete.
 */
export const listAnnotationSets = async (
  db: Database,
  { panelId }: { panelId: string },
): Promise<AnnotationSetRow[]> =>
  db
    .select({
      id: schema.annotationSets.id,
      name: schema.annotationSets.name,
      createdAt: schema.annotationSets.createdAt,
      archivedAt: schema.annotationSets.archivedAt,
      createdByEmail: schema.user.email,
      // QUALIFIED BY HAND. A Drizzle column inside a `sql` template renders UNQUALIFIED, so
      // an unqualified `"id"` in this subquery would bind to `annotation_set_traces.id` —
      // which does not exist here, and where it does exist makes the correlation always false
      // with no error anywhere (M5 Deviations 19 and 35, M4 Deviation 60).
      size: sql<number>`(
        SELECT count(*)::int FROM annotation_set_traces
        WHERE annotation_set_traces.annotation_set_id = "annotation_sets"."id"
      )`.mapWith(Number),
    })
    .from(schema.annotationSets)
    .innerJoin(schema.user, eq(schema.user.id, schema.annotationSets.createdBy))
    .where(eq(schema.annotationSets.panelId, panelId))
    .orderBy(desc(schema.annotationSets.createdAt))

/** The set, scoped to the session's org. `undefined` for another org's and for one that is not. */
export const findAnnotationSet = async (db: Executor, orgId: string, setId: string) => {
  const [row] = await db
    .select({
      id: schema.annotationSets.id,
      orgId: schema.annotationSets.orgId,
      panelId: schema.annotationSets.panelId,
      name: schema.annotationSets.name,
      archivedAt: schema.annotationSets.archivedAt,
    })
    .from(schema.annotationSets)
    .where(and(eq(schema.annotationSets.id, setId), eq(schema.annotationSets.orgId, orgId)))
    .limit(1)
  return row
}

/** Who is assigned right now, and which of them is the dictator. */
export const listAssignedAnnotators = async (db: Executor, setId: string) =>
  db
    .select({
      userId: schema.annotationSetAnnotators.userId,
      isDictator: schema.annotationSetAnnotators.isDictator,
      assignedAt: schema.annotationSetAnnotators.assignedAt,
    })
    .from(schema.annotationSetAnnotators)
    .where(
      and(
        eq(schema.annotationSetAnnotators.annotationSetId, setId),
        isNull(schema.annotationSetAnnotators.unassignedAt),
      ),
    )
    .orderBy(asc(schema.annotationSetAnnotators.assignedAt))

const memberIds = async (db: Executor, setId: string): Promise<string[]> => {
  const rows = await db
    .select({ traceId: schema.annotationSetTraces.traceId })
    .from(schema.annotationSetTraces)
    .where(eq(schema.annotationSetTraces.annotationSetId, setId))
  return rows.map((row) => row.traceId)
}

// ── Create ────────────────────────────────────────────────────────────────────────────────

export type CreateResult =
  | { ok: true; setId: string; added: number }
  | { ok: false; kind: 'name_taken' }
  | { ok: false; kind: 'unknown_traces'; traceIds: string[] }

export const createAnnotationSet = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  panelId,
  name,
  pick,
}: Actor & { panelId: string; name: string; pick: AnnotationSetPick }): Promise<CreateResult> => {
  const now = new Date(clock.now())
  const setId = newId('aset_')

  try {
    return await db.transaction(async (tx) => {
      const resolved = await resolveTraces(tx, { panelId, pick, exclude: [] })
      if (!resolved.ok) return { ok: false, kind: 'unknown_traces', traceIds: resolved.traceIds }

      await tx.insert(schema.annotationSets).values({
        id: setId,
        orgId,
        panelId,
        name,
        createdBy: actorId,
        createdAt: now,
      })
      const added = await addTraces(tx, {
        setId,
        traceIds: resolved.traceIds,
        strategy: pick.strategy,
        actorId,
        now,
      })
      await recordAuditEvent(tx, {
        orgId,
        actorType: 'user',
        actorId,
        action: 'annotation_set.created',
        subjectType: 'annotation_set',
        subjectId: setId,
        // Strategy, what was ASKED for, and what arrived — never the ids themselves.
        data: { panel_id: panelId, strategy: pick.strategy, requested: pickSize(pick), added },
        requestId,
      })
      return { ok: true, setId, added } as const
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { ok: false, kind: 'name_taken' }
    throw error
  }
}

// ── Top up ────────────────────────────────────────────────────────────────────────────────

/**
 * Each failure is its OWN arm rather than one arm with a union `kind`. TypeScript narrows the
 * discriminant either way, but only separate arms can be EXCLUDED — and the route wants
 * `unknown_traces` gone from the type once it has handled it, so `traceIds` stops being
 * reachable where it does not exist.
 */
export type TopUpResult =
  | { ok: true; added: number; size: number }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'archived' }
  | { ok: false; kind: 'at_cap' }
  | { ok: false; kind: 'unknown_traces'; traceIds: string[] }

/**
 * Run a picker again and APPEND (ADR-0080). The cap is checked against what the set already
 * holds, so a top-up cannot take it past 250 however many times it is called (ADR-0082).
 */
export const topUpAnnotationSet = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  setId,
  pick,
}: Actor & { setId: string; pick: AnnotationSetPick }): Promise<TopUpResult> => {
  const now = new Date(clock.now())
  const set = await findAnnotationSet(db, orgId, setId)
  if (set === undefined) return { ok: false, kind: 'not_found' }
  if (set.archivedAt !== null) return { ok: false, kind: 'archived' }

  return db.transaction(async (tx) => {
    const held = await memberIds(tx, setId)
    if (held.length >= ANNOTATION_SET_MAX_SIZE) return { ok: false, kind: 'at_cap' } as const

    const resolved = await resolveTraces(tx, { panelId: set.panelId, pick, exclude: held })
    if (!resolved.ok) return { ok: false, kind: 'unknown_traces', traceIds: resolved.traceIds }

    // Whatever the picker returned, only as many as the cap leaves room for.
    const room = ANNOTATION_SET_MAX_SIZE - held.length
    const added = await addTraces(tx, {
      setId,
      traceIds: resolved.traceIds.slice(0, room),
      strategy: pick.strategy,
      actorId,
      now,
    })
    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'annotation_set.topped_up',
      subjectType: 'annotation_set',
      subjectId: setId,
      data: {
        strategy: pick.strategy,
        requested: pickSize(pick),
        added,
        size: held.length + added,
      },
      requestId,
    })
    return { ok: true, added, size: held.length + added } as const
  })
}

/** The one INSERT into the snapshot. `ON CONFLICT DO NOTHING`: a re-picked trace adds nothing. */
const addTraces = async (
  tx: Executor,
  {
    setId,
    traceIds,
    strategy,
    actorId,
    now,
  }: {
    setId: string
    traceIds: readonly string[]
    strategy: AnnotationSetStrategy
    actorId: string
    now: Date
  },
): Promise<number> => {
  if (traceIds.length === 0) return 0
  const inserted = await tx
    .insert(schema.annotationSetTraces)
    .values(
      traceIds.map((traceId) => ({
        annotationSetId: setId,
        traceId,
        strategy,
        addedAt: now,
        addedBy: actorId,
      })),
    )
    .onConflictDoNothing()
    .returning({ traceId: schema.annotationSetTraces.traceId })
  return inserted.length
}

// ── Assign ────────────────────────────────────────────────────────────────────────────────

export type AssignInput = { userId: string; isDictator: boolean }

export type AssignResult =
  | { ok: true; assigned: number; unassigned: number; dictatorId: string | null }
  | { ok: false; kind: 'not_found' }
  | { ok: false; kind: 'archived' }
  | { ok: false; kind: 'dictator_required' }
  | { ok: false; kind: 'not_members'; userIds: string[] }

/**
 * WHO IS ASSIGNED, declared in full. The list IS the assignment: anyone currently assigned and
 * not named in it is unassigned by this call, which stamps `unassigned_at` and keeps the row.
 *
 * **Two rules, and the second is the one worth stating** (open question 6, ADR-0081):
 *
 * 1. Everyone named must be a MEMBER of the org who may annotate — not "an annotator". A
 *    developer may be assigned a set and annotate it like anyone else (M5 decision 3, revised
 *    2026-09-21); what they may not do is arrive without having chosen to.
 * 2. **A call that would leave two or more assigned annotators with no dictator is refused** —
 *    whether it names none, or unassigns the one there is. One rule in both directions, so no
 *    ordering of calls reaches a set with a disagreement and nobody to settle it. Their past
 *    answers stay and stay visible; they simply stop being the tie-break, which re-reads every
 *    past disagreement in the set because the dictator rule is a READ rule.
 */
export const assignAnnotators = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  setId,
  annotators,
}: Actor & { setId: string; annotators: readonly AssignInput[] }): Promise<AssignResult> => {
  const now = new Date(clock.now())
  const set = await findAnnotationSet(db, orgId, setId)
  if (set === undefined) return { ok: false, kind: 'not_found' }
  if (set.archivedAt !== null) return { ok: false, kind: 'archived' }

  const wanted = new Map(annotators.map((annotator) => [annotator.userId, annotator]))
  const dictator = annotators.find((annotator) => annotator.isDictator) ?? null

  // Rule 2, checked against what the call would LEAVE rather than against what it names.
  if (wanted.size >= 2 && dictator === null) {
    return { ok: false, kind: 'dictator_required' }
  }

  if (wanted.size > 0) {
    const members = await db
      .select({ userId: schema.orgMembers.userId, role: schema.orgMembers.role })
      .from(schema.orgMembers)
      .where(
        and(
          eq(schema.orgMembers.orgId, orgId),
          inArray(schema.orgMembers.userId, [...wanted.keys()]),
        ),
      )
    const assignable = new Set(
      members
        .filter((member) => can(member.role as OrgRole, { annotation: ['create'] }))
        .map((member) => member.userId),
    )
    const refused = [...wanted.keys()].filter((userId) => !assignable.has(userId))
    if (refused.length > 0) return { ok: false, kind: 'not_members', userIds: refused }
  }

  return db.transaction(async (tx) => {
    const current = await tx
      .select({
        userId: schema.annotationSetAnnotators.userId,
        isDictator: schema.annotationSetAnnotators.isDictator,
        unassignedAt: schema.annotationSetAnnotators.unassignedAt,
      })
      .from(schema.annotationSetAnnotators)
      .where(eq(schema.annotationSetAnnotators.annotationSetId, setId))
      .for('update')

    const assignedNow = current.filter((row) => row.unassignedAt === null)
    const leaving = assignedNow.filter((row) => !wanted.has(row.userId))

    // THE DICTATOR IS CLEARED FIRST, always. The partial unique index is over the currently
    // assigned, so naming a new dictator before the old one has been stood down would be two
    // live dictators for the length of one statement — which the database refuses outright.
    if (assignedNow.some((row) => row.isDictator)) {
      await tx
        .update(schema.annotationSetAnnotators)
        .set({ isDictator: false })
        .where(
          and(
            eq(schema.annotationSetAnnotators.annotationSetId, setId),
            isNull(schema.annotationSetAnnotators.unassignedAt),
          ),
        )
    }

    for (const row of leaving) {
      await tx
        .update(schema.annotationSetAnnotators)
        .set({ unassignedAt: now })
        .where(
          and(
            eq(schema.annotationSetAnnotators.annotationSetId, setId),
            eq(schema.annotationSetAnnotators.userId, row.userId),
          ),
        )
    }

    for (const annotator of wanted.values()) {
      await tx
        .insert(schema.annotationSetAnnotators)
        .values({
          annotationSetId: setId,
          userId: annotator.userId,
          isDictator: annotator.isDictator,
          assignedBy: actorId,
          assignedAt: now,
        })
        // Re-assigning somebody who was unassigned clears the stamp and keeps the original
        // row — their answers were never detached from it.
        .onConflictDoUpdate({
          target: [
            schema.annotationSetAnnotators.annotationSetId,
            schema.annotationSetAnnotators.userId,
          ],
          set: { isDictator: annotator.isDictator, unassignedAt: null, assignedBy: actorId },
        })
    }

    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'annotation_set.annotators_assigned',
      subjectType: 'annotation_set',
      subjectId: setId,
      // Ids of PEOPLE, which the audit log already carries everywhere (a membership is a
      // grant). Trace ids are what it never carries.
      data: {
        assigned: [...wanted.keys()],
        unassigned: leaving.map((row) => row.userId),
        dictator_id: dictator?.userId ?? null,
      },
      requestId,
    })

    return {
      ok: true,
      assigned: wanted.size,
      unassigned: leaving.length,
      dictatorId: dictator?.userId ?? null,
    } as const
  })
}

// ── Archive ───────────────────────────────────────────────────────────────────────────────

export type ArchiveResult = { ok: true; archivedAt: Date } | { ok: false; kind: 'not_found' }

/**
 * A PERSON puts the set away (ADR-0086). One nullable stamp, and it says nothing about whether
 * the set is done: a half-finished pass can be abandoned and a finished one can be left out.
 *
 * Archiving twice is the same answer as archiving once — the first stamp stands, because when
 * it was put away is the fact worth keeping.
 */
export const archiveAnnotationSet = async ({
  db,
  clock,
  orgId,
  actorId,
  requestId,
  setId,
}: Actor & { setId: string }): Promise<ArchiveResult> => {
  const now = new Date(clock.now())
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.annotationSets)
      .set({ archivedAt: now })
      .where(
        and(
          eq(schema.annotationSets.id, setId),
          eq(schema.annotationSets.orgId, orgId),
          isNull(schema.annotationSets.archivedAt),
        ),
      )
      .returning({ archivedAt: schema.annotationSets.archivedAt })

    if (row === undefined) {
      const existing = await findAnnotationSet(tx, orgId, setId)
      if (existing?.archivedAt != null)
        return { ok: true, archivedAt: existing.archivedAt } as const
      return { ok: false, kind: 'not_found' } as const
    }

    await recordAuditEvent(tx, {
      orgId,
      actorType: 'user',
      actorId,
      action: 'annotation_set.archived',
      subjectType: 'annotation_set',
      subjectId: setId,
      data: null,
      requestId,
    })
    // biome-ignore lint/style/noNonNullAssertion: the UPDATE set it, so RETURNING cannot be null.
    return { ok: true, archivedAt: row.archivedAt! } as const
  })
}

/**
 * A duplicate name, answered by the DATABASE rather than by a read-then-write that two
 * simultaneous creates would both pass.
 *
 * The SQLSTATE is read off the CAUSE as well as the error: Drizzle wraps the driver's error,
 * so `error.code` is undefined and `error.cause.code` is the 23505 (the same trap
 * `annotate.test.ts` documents). The constraint name is checked too — only the name index can
 * raise this here, and naming it means a future unique index cannot quietly be reported to a
 * caller as "that name is taken".
 */
const NAME_INDEX = 'annotation_sets_panel_name_key'

const isUniqueViolation = (error: unknown): boolean => {
  const wrapped = error as {
    code?: string
    constraint?: string
    cause?: { code?: string; constraint?: string }
  }
  const code = wrapped?.cause?.code ?? wrapped?.code
  const constraint = wrapped?.cause?.constraint ?? wrapped?.constraint
  return code === '23505' && constraint === NAME_INDEX
}
