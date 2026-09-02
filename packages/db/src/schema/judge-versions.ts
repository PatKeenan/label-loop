import type { ModelPin, ModelPinValidation } from '@labelloop/contracts'
import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, real, text, uniqueIndex } from 'drizzle-orm/pg-core'
import { createdBy } from './authored.ts'
import { createdAt, id, idCheck, jsonbColumn, judgePolarity, judgeType } from './columns.ts'
import { judges } from './judges.ts'

/**
 * An immutable judge configuration (ADR-0003). Every trace verdict, annotation, eval score
 * and dataset row references one of these, which is what makes agreement measurable per
 * version and attribution possible per expert.
 */
export const judgeVersions = pgTable(
  'judge_versions',
  {
    id: id('jdv_').primaryKey(),
    judgeId: text('judge_id')
      .notNull()
      .references(() => judges.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    /**
     * `code` reduces the check to a schema assertion or a regex — near-zero cost and
     * latency, perfect precision by construction, nothing to align. `llm` is the one that
     * costs money and can drift. Axial coding triages each category into one of the two.
     */
    type: judgeType('type').notNull(),
    /**
     * THE column this table exists to get right (ADR-0019). It says what answering `true`
     * means for the thing this judge examines: `passes` or `fails`. `is-missing-repro:
     * true` is a failure. `on-brand: true` is a success. Without this the panel score is
     * uncomputable, because summing raw verdicts across judges that point in opposite
     * directions produces a number that looks meaningful and is not.
     *
     * Two-valued, deliberately (ADR-0034): a judge that scores nothing is not a judge, and
     * `passed` is therefore null for exactly one reason — the judge did not run.
     */
    polarity: judgePolarity('polarity').notNull(),
    /**
     * Relative weight within the panel, normalised to sum to 1 across the judges that
     * actually ran when the score is computed.
     *
     * **NOT NULL, and a column constraint rather than a CHECK** (ADR-0035). Every judge
     * scores, so a null is unrepresentable rather than merely unused — and the constraint
     * flows into Drizzle's inferred types, which turns "the score is uncomputable" into a
     * compile error rather than a runtime one. This is CONFIGURATION, and is not the same
     * field as the `Verdict.weight` in the published contract: that one is the normalised
     * share actually applied on one request, and is genuinely absent for a judge that
     * never ran.
     */
    weight: real('weight').notNull(),
    /**
     * A veto. A required judge that fails, is skipped, fails to answer or errors fails the
     * panel outright, whatever the score says — which is how `weighted_threshold` expresses
     * the "veto" policy without a second code path (ADR-0019).
     *
     * Ships as a column at M0 and stays UNENFORCED until the fan-out at P4 exists: the
     * same "cheap column now, painful migration later" reasoning as `org_members.role`.
     */
    required: boolean('required').notNull().default(false),
    /** The binary question put to the model. Prompts live in versioned configs, not code. */
    question: text('question').notNull(),
    /**
     * Which model answers it — route-qualified, `<route>:<native-id>` (ADR-0022). Null for
     * `code` judges, which call nothing. The prefix names the ACCESS PATH, not just the
     * model, because the same model is not the same capability surface reached two ways.
     */
    model: text('model'),
    /**
     * **What this judge is actually frozen against** (ADR-0022, ADR-0025): the properties
     * an endpoint must HAVE to serve it, not the name of an endpoint. Required capabilities,
     * the data-collection stance (ADR-0023), acceptable quantizations, and the reasoning
     * effort — translated into the provider's routing controls on every call.
     *
     * A bare model name would leave the judge's real capability decided by routing, at call
     * time, by someone who is not us: measured 2026-08-28, `anthropic/claude-sonnet-5`
     * exposed nine endpoints and three could not do structured output at all, while the
     * model-level capability list advertised it because that field is a UNION across
     * endpoints. Judge output is a parsed contract, so that failure is unusable rather than
     * merely degraded.
     */
    modelPin: jsonbColumn<ModelPin>('model_pin'),
    /**
     * What one real call observed when this pin was validated, before the row froze:
     * `{validated_at, available_endpoints, served_by}`.
     *
     * **Its own column, not a field inside the pin** (ADR-0026). The pin is a CONSTRAINT
     * translated onto the wire; this is a MEASUREMENT taken once. Merging them would ship
     * non-request data inside the request body. Nullable because the four M0-seeded `fake:`
     * judges predate any validation and there was nothing to route.
     */
    modelPinValidation: jsonbColumn<ModelPinValidation>('model_pin_validation'),
    /** Who authored this row. See `authored.ts` for why it is `user`. */
    createdBy: createdBy(),
    createdAt: createdAt(),
  },
  (table) => [
    idCheck('judge_versions', table.id, 'jdv_'),
    uniqueIndex('judge_versions_judge_version_key').on(table.judgeId, table.version),
    check('judge_versions_version_positive', sql`${table.version} >= 1`),
    // Presence is the column's own NOT NULL (ADR-0035). This is the separate half of the
    // rule: zero is perfectly representable and still meaningless, because a judge weighted
    // zero takes no share of the score and cannot move it — an unreachable judge dressed as
    // a configured one, which is the row that makes a panel quietly score less than it
    // appears to. Named for what it asserts: the old name described a relationship to
    // polarity that no longer exists, and a constraint whose name lies is worse than a
    // verbose one.
    check('judge_versions_weight_positive', sql`${table.weight} > 0`),
    // A `code` judge calls no model; an `llm` judge must name one.
    check(
      'judge_versions_model_matches_type',
      sql`(${table.type} = 'code' AND ${table.model} IS NULL)
          OR (${table.type} = 'llm' AND ${table.model} IS NOT NULL)`,
    ),
    // The clean MIRROR of the rule above, which is why every `llm` judge carries a pin
    // even where it constrains nothing — a `fake:` route has no endpoints to route among
    // (ADR-0025). A route-conditional rule would have to be re-reasoned at every read;
    // this one is the same shape as the model rule and needs reading once.
    check(
      'judge_versions_pin_matches_type',
      sql`(${table.type} = 'code' AND ${table.modelPin} IS NULL)
          OR (${table.type} = 'llm' AND ${table.modelPin} IS NOT NULL)`,
    ),
  ],
)
