import type { ModelPin, ModelPinValidation } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { and, count, countDistinct, desc, eq, ne, sql } from 'drizzle-orm'
import type { Executor } from './executor.ts'

/**
 * Reading the configuration an evaluation runs against.
 *
 * The shape returned here is the whole of what a panel *is* at request time: an immutable
 * `pnv_` (threshold, policy) and the judge versions it pins. Nothing mutable is read —
 * which is the point of ADR-0003. Two evaluations against the same `pnv_` ran against
 * byte-identical configuration, and a score timeline can therefore never silently span a
 * configuration change.
 */

export type PanelJudge = {
  /** The stable `jud_` identity, and what the response keys are named after. */
  judgeId: string
  /** `is-p0`, `is-missing-repro` — the name a developer writes in their own code. */
  slug: string
  /** The immutable `jdv_` every verdict, annotation and eval score FKs to. */
  judgeVersionId: string
  type: 'code' | 'llm'
  polarity: 'passes' | 'fails'
  /**
   * The customer's declared importance for this judge, normalised across the judges that
   * actually ran when the score is computed. Never null: every judge scores (ADR-0034),
   * and the column's own NOT NULL is what makes that a type rather than a hope (ADR-0035).
   */
  weight: number
  /** A veto: failing, skipping or erroring fails the panel whatever the score says. */
  required: boolean
  question: string
  /** Null for `code` judges, which call nothing. */
  model: string | null
  /**
   * The routing constraints frozen onto this version (ADR-0022). Null exactly when `model`
   * is — the CHECK enforces the pairing, so a judge with one and not the other cannot be
   * read because it cannot be written.
   */
  modelPin: ModelPin | null
}

export type LivePanel = {
  panelId: string
  orgId: string
  panelVersionId: string
  threshold: number
  aggregationPolicy: 'weighted_threshold'
  judges: PanelJudge[]
}

/**
 * The live configuration for one panel, or `undefined` when there is none to run.
 *
 * "Live" is the POINTER on `panels`, never the highest version number. They are different
 * facts: reading the maximum would make rollback impossible and would put every freshly
 * inserted draft straight into production traffic.
 */
export const findLivePanel = async (
  db: Database,
  panelId: string,
): Promise<LivePanel | undefined> => {
  const panel = await db.query.panels.findFirst({
    where: eq(schema.panels.id, panelId),
    columns: { id: true, orgId: true },
    with: {
      currentVersion: {
        columns: { id: true, threshold: true, aggregationPolicy: true },
        with: {
          judgeVersions: {
            with: {
              judgeVersion: {
                columns: {
                  id: true,
                  type: true,
                  polarity: true,
                  weight: true,
                  required: true,
                  question: true,
                  model: true,
                  // Selected because it goes onto the wire on every judge call. A pin read
                  // from the row is the only thing that makes the frozen version mean
                  // anything at request time.
                  modelPin: true,
                },
                with: { judge: { columns: { id: true, slug: true } } },
              },
            },
          },
        },
      },
    },
  })

  if (panel?.currentVersion == null) return undefined
  const version = panel.currentVersion

  return {
    panelId: panel.id,
    orgId: panel.orgId,
    panelVersionId: version.id,
    threshold: version.threshold,
    aggregationPolicy: version.aggregationPolicy,
    // Ordered by slug so a panel's judges fan out, log and read back in a stable order.
    // Postgres makes no promise about row order without one, and an unstable order would
    // make the response's key order — and every test over it — quietly nondeterministic.
    judges: version.judgeVersions
      .map(({ judgeVersion }) => ({
        judgeId: judgeVersion.judge.id,
        slug: judgeVersion.judge.slug,
        judgeVersionId: judgeVersion.id,
        type: judgeVersion.type,
        polarity: judgeVersion.polarity,
        weight: judgeVersion.weight,
        required: judgeVersion.required,
        modelPin: judgeVersion.modelPin,
        question: judgeVersion.question,
        model: judgeVersion.model,
      }))
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
  }
}

/**
 * ONE panel, addressed the way the console addresses it: by SLUG, within the session's org.
 *
 * By slug rather than id because the slug is what lives in the URL (`/p/triage-routing`) and
 * what a person can read and share — the console resolves it here rather than holding an id
 * it never showed anyone. `orgId` is a required argument, not an optional filter, exactly as
 * `listPanels` and `listTraces` have it: there is no way to call this across tenants, which
 * is the property that stops a console growing the classic "authenticate then forget to
 * filter" hole.
 *
 * It answers TWO screens with one read, because they are two views of one object: the
 * panel's Overview (its state, and progress toward the annotation gate) and its Judges
 * section (the current version, read-only). Splitting them would be two round trips for a
 * page that renders both.
 *
 * `undefined` for a panel that does not exist AND for one in another org — deliberately
 * indistinguishable, so the response cannot confirm that a panel exists (ADR-0057, applied
 * to panels the same way `panelBelongsToOrg` applies it).
 */
export const findPanelBySlug = async (db: Database, orgId: string, slug: string) => {
  const panel = await db.query.panels.findFirst({
    // Both predicates, always. The slug is unique per ORG (`panels_org_slug_key`), not
    // globally, so a slug alone would be ambiguous as well as leaky.
    where: and(eq(schema.panels.orgId, orgId), eq(schema.panels.slug, slug)),
    columns: { id: true, slug: true, name: true, createdAt: true, currentVersionId: true },
    with: {
      currentVersion: {
        columns: { id: true, threshold: true, aggregationPolicy: true },
        with: {
          judgeVersions: {
            with: {
              judgeVersion: {
                columns: {
                  id: true,
                  type: true,
                  polarity: true,
                  weight: true,
                  required: true,
                  question: true,
                  model: true,
                  modelPin: true,
                },
                with: { judge: { columns: { id: true, slug: true, name: true } } },
              },
            },
          },
        },
      },
    },
  })

  if (panel === undefined) return undefined

  // A panel with no live version cannot be evaluated at all, so it has no threshold to
  // report. It is representable — `currentVersionId` is nullable — and the console renders
  // it as a panel that exists and cannot yet be called.
  const version = panel.currentVersion ?? null

  const [counted] = await db
    .select({ traces: count() })
    .from(schema.traces)
    .where(eq(schema.traces.panelId, panel.id))

  /**
   * How many of this panel's traces have been ANNOTATED — the second half of the gate card
   * (M5 phase 6): traces fill toward the floor, annotations toward the target.
   *
   * DISTINCT on the trace, deliberately. The table is append-only, so one person changing
   * their mind writes a second row, and two annotators on one trace will be ordinary from
   * phase 7 — a raw `count(*)` would report progress that nobody made. What the target
   * measures is COVERAGE: how much of the panel somebody has now read.
   *
   * Skips excluded, the same rule the queue and the trace list use: a skip is an answer we
   * store and not an annotation.
   */
  const [annotated] = await db
    .select({ traces: countDistinct(schema.annotations.traceId) })
    .from(schema.annotations)
    .where(and(eq(schema.annotations.panelId, panel.id), ne(schema.annotations.outcome, 'skipped')))

  return {
    id: panel.id,
    slug: panel.slug,
    name: panel.name,
    createdAt: panel.createdAt,
    panelVersionId: version?.id ?? null,
    threshold: version?.threshold ?? null,
    aggregationPolicy: version?.aggregationPolicy ?? null,
    /**
     * Every trace this panel has captured, judged or not. It is what the Overview counts
     * toward the annotation gate (ADR-0061), so it deliberately does NOT filter by state:
     * a collecting trace is exactly the kind an annotator will read.
     */
    traceCount: counted?.traces ?? 0,
    /** Traces with at least one non-skip annotation — coverage, not row count. */
    annotatedTraceCount: annotated?.traces ?? 0,
    judges: (version?.judgeVersions ?? [])
      .map(({ judgeVersion }) => ({
        judgeId: judgeVersion.judge.id,
        judgeVersionId: judgeVersion.id,
        slug: judgeVersion.judge.slug,
        name: judgeVersion.judge.name,
        type: judgeVersion.type,
        polarity: judgeVersion.polarity,
        weight: judgeVersion.weight,
        required: judgeVersion.required,
        question: judgeVersion.question,
        model: judgeVersion.model,
        modelPin: judgeVersion.modelPin,
      }))
      // Same reason `findLivePanel` sorts: Postgres promises no row order, and an unstable
      // one would make the response — and every test over it — quietly nondeterministic.
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)),
  }
}

/**
 * DERIVED from the query, never restated.
 *
 * The first draft wrote this shape out by hand and got it wrong twice in one go — `model` is
 * nullable and `type` is a union, not `string` — which the typecheck refused. That is the
 * same rule `queries.ts` states for responses and the same mistake Deviation 48 caught in
 * the console's role union: a hand-written type is the thing that drifts.
 */
export type ConsolePanelRead = NonNullable<Awaited<ReturnType<typeof findPanelBySlug>>>

/**
 * Does this panel belong to this org?
 *
 * The check that stops a key being scoped to somebody else's panel — the one tenancy hole a
 * create endpoint taking a `panel_id` actually has. It returns a BOOLEAN rather than the
 * panel, because the caller must not be able to use it as a read: a handler that received the
 * row would be one refactor away from rendering a panel it only asked permission about.
 *
 * A false answer is `NOT_FOUND` at the route, never `FORBIDDEN`, for the same reason
 * ADR-0057 gives for orgs — the two cases must stay indistinguishable, or the endpoint
 * enumerates other tenants' panel ids.
 */
export const panelBelongsToOrg = async (
  db: Executor,
  panelId: string,
  orgId: string,
): Promise<boolean> => {
  const rows = await db
    .select({ id: schema.panels.id })
    .from(schema.panels)
    .where(and(eq(schema.panels.id, panelId), eq(schema.panels.orgId, orgId)))
    .limit(1)
  return rows.length > 0
}

// ─── The write half (M4 phase 5) ───────────────────────────────────────────────────────────
//
// The first code outside `scripts/seed.ts` to write any of these five tables. Every function
// below takes an `Executor`, because they are only ever meant to run together inside ONE
// transaction: a panel with a version and no judges reads as a panel whose judges were all
// deleted, and an activated pointer at a version with no membership rows serves a panel that
// judges nothing. Neither looks like corruption — both look like a configuration — which is
// what makes a half-written panel dangerous rather than merely untidy.
//
// **There is no update and no delete for the version tables here, and there cannot be.**
// Migration 0005 REVOKES both from the app role on `panel_versions` and `judge_versions`, so
// "editing" a panel is writing version n+1 and moving the pointer. The one UPDATE below is on
// `panels`, which keeps the grant precisely so activation stays possible.

export type NewPanel = {
  id: string
  orgId: string
  slug: string
  name: string
  createdBy: string | null
}

export const insertPanel = async (db: Executor, panel: NewPanel): Promise<void> => {
  // `current_version_id` is left NULL: a panel exists for a moment before its first version
  // does, and the composite foreign key permits exactly that (MATCH SIMPLE).
  await db.insert(schema.panels).values(panel)
}

export type NewPanelVersion = {
  id: string
  panelId: string
  version: number
  threshold: number
  createdBy: string | null
}

export const insertPanelVersion = async (db: Executor, version: NewPanelVersion): Promise<void> => {
  await db.insert(schema.panelVersions).values(version)
}

export type NewJudge = {
  id: string
  panelId: string
  slug: string
  name: string
  createdBy: string | null
}

export const insertJudge = async (db: Executor, judge: NewJudge): Promise<void> => {
  await db.insert(schema.judges).values(judge)
}

export type NewJudgeVersion = {
  id: string
  judgeId: string
  version: number
  polarity: 'passes' | 'fails'
  weight: number
  required: boolean
  question: string
  model: string
  modelPin: ModelPin
  /**
   * What the validating call observed (ADR-0026). Required here even though the column is
   * nullable: the column is nullable only for the four M0-seeded judges that predate
   * validation, and nothing written by this path may skip it.
   */
  modelPinValidation: ModelPinValidation
  createdBy: string | null
}

/**
 * Always `type: 'llm'`. The parameter does not accept a type because M4 cannot create any
 * other kind honestly — see `services/create-panel.ts` on why `code` judges are refused.
 */
export const insertJudgeVersion = async (db: Executor, version: NewJudgeVersion): Promise<void> => {
  await db.insert(schema.judgeVersions).values({ ...version, type: 'llm' })
}

/** Pins a judge version into a panel version's judge set — what makes `pnv_` mean anything. */
export const linkPanelVersionJudge = async (
  db: Executor,
  panelVersionId: string,
  judgeVersionId: string,
): Promise<void> => {
  await db.insert(schema.panelVersionJudges).values({ panelVersionId, judgeVersionId })
}

/**
 * Point a panel at a version: the ACTIVATION gesture, and a separate act from creating it.
 *
 * It cannot be folded into the panel insert — the version does not exist yet at that point,
 * and the pointer's composite foreign key `(id, current_version_id)` →
 * `panel_versions (panel_id, id)` would refuse it. The same key is what stops a panel
 * activating a version that belongs to a DIFFERENT panel, which a plain reference to `id`
 * alone would have allowed while looking correct.
 */
export const activatePanelVersion = async (
  db: Executor,
  panelId: string,
  panelVersionId: string,
  at: Date,
): Promise<void> => {
  await db
    .update(schema.panels)
    .set({ currentVersionId: panelVersionId, updatedAt: at })
    .where(eq(schema.panels.id, panelId))
}

/** One row of the console's panel list. */
export type PanelListItem = {
  id: string
  slug: string
  name: string
  currentVersionId: string | null
  createdAt: Date
  /**
   * Enough for a list ROW to say something, which an id and a name do not.
   *
   * Both are correlated subqueries in the one statement rather than a second round trip per
   * panel: the list is small, and a per-row query is how a list endpoint quietly becomes N+1
   * the first time an org has thirty panels.
   */
  judgeCount: number
  traceCount: number
}

/**
 * Every panel for ONE org, newest first. `orgId` is required rather than an optional filter,
 * as `listTraces` and `listApiKeys` have it: there is no way to call this across tenants.
 */
export const listPanels = async (db: Executor, orgId: string): Promise<PanelListItem[]> =>
  db
    .select({
      id: schema.panels.id,
      slug: schema.panels.slug,
      name: schema.panels.name,
      currentVersionId: schema.panels.currentVersionId,
      createdAt: schema.panels.createdAt,
      /**
       * **Both correlated references are QUALIFIED, and that is not stylistic.**
       *
       * Drizzle renders a column inside a `sql` template UNQUALIFIED — `${schema.traces.panelId}`
       * becomes `"panel_id"`, not `"traces"."panel_id"`. Inside a subquery, an unqualified name
       * binds to the INNER table whenever it exists there, so the first version of the trace
       * count compiled to `where "panel_id" = "id"`, which Postgres read as
       * `traces.panel_id = traces.id` and answered 0 for every panel. No error, no warning, a
       * plausible number.
       *
       * The judge count next to it was CORRECT BY LUCK on the same construction:
       * `panel_version_judges` has no `current_version_id` column, so the outer reference had
       * nowhere else to bind. Both are written the safe way now rather than leaving one
       * depending on a column that does not happen to exist.
       */
      judgeCount: sql<number>`(
        select count(*) from ${schema.panelVersionJudges} as pvj
        where pvj.panel_version_id = ${schema.panels}.current_version_id
      )`.mapWith(Number),
      // Every trace, judged or not: it is what the annotation gate counts (ADR-0061).
      traceCount: sql<number>`(
        select count(*) from ${schema.traces} as tr
        where tr.panel_id = ${schema.panels}.id
      )`.mapWith(Number),
    })
    .from(schema.panels)
    .where(eq(schema.panels.orgId, orgId))
    .orderBy(desc(schema.panels.createdAt))
