import type { ModelPin } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { schema } from '@labelloop/db'
import { eq } from 'drizzle-orm'

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
