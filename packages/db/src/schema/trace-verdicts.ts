import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
} from 'drizzle-orm/pg-core'
import { createdAt, verdictStatus } from './columns.ts'
import { judgeVersions } from './judge-versions.ts'
import { traces } from './traces.ts'

/**
 * One judge's answer within one evaluation — the row ADR-0003's "every trace, annotation,
 * eval score and dataset row FKs to a `jdv_`" actually refers to, since a panel run fans
 * out across many judge versions and the trace itself can only reference one panel version.
 *
 * It is a table rather than a JSON blob on the trace for three reasons that all bite
 * later: an SME annotates a *verdict*, not a whole panel run, so M5 needs something to
 * attach to; the contribution ledger attributes payouts per judge; and metering has to be
 * decomposable at judge granularity, because each judge has its own model and graduates
 * independently, so cost moves per judge rather than per panel. None of the three can be
 * recovered from an aggregate after the fact.
 */
export const traceVerdicts = pgTable(
  'trace_verdicts',
  {
    traceId: text('trace_id')
      .notNull()
      .references(() => traces.id, { onDelete: 'cascade' }),
    judgeVersionId: text('judge_version_id')
      .notNull()
      .references(() => judgeVersions.id, { onDelete: 'restrict' }),
    /**
     * Why this verdict is what it is. Only `evaluated` carries an answer; the rest exist
     * so a caller is never handed a pass for a judge that never ran, and so the two
     * reasons `passed` can be null stay distinguishable — informational, or absent.
     */
    status: verdictStatus('status').notNull(),
    /**
     * The judge's raw binary answer, and the field an annotator agrees with or corrects.
     * Null unless `status` is `evaluated`.
     */
    verdict: boolean('verdict'),
    /**
     * That answer under the judge's polarity — what the score sums. Null both for
     * informational judges and for judges that never answered; `status` disambiguates.
     */
    passed: boolean('passed'),
    /** One capped line for a human, generated BEFORE the verdict (ADR-0019). */
    rationale: text('rationale'),
    /**
     * Taxonomy codes, and the field an agent branches on: prose cannot be acted upon, a
     * code can be mapped to a remediation. This is what makes a propose→judge→revise loop
     * directed rather than random.
     */
    reasons: jsonb('reasons').$type<string[]>().notNull().default([]),
    /** Not a softened verdict — the verdict stays binary. This is what M5 samples on. */
    confidence: real('confidence'),
    /** The normalised weight actually applied, pinned so the score is recomputable. */
    weight: real('weight'),
    /** `frontier:sonnet`, `finetune:acme-tone-v3` — graduation, visible per verdict. */
    servedBy: text('served_by'),
    /** Judges fan out in parallel, so the panel's total is the slowest one of these. */
    latencyMs: integer('latency_ms'),
    /** Surfaces retry flakiness that a bare success would hide. */
    attempts: integer('attempts').notNull().default(0),
    /**
     * The provider's untouched response, stored alongside the normalised fields above
     * (CONVENTIONS.md "Data rules") so an evaluation is rerunnable and auditable rather
     * than only as good as today's parser.
     */
    rawResponse: jsonb('raw_response'),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.traceId, table.judgeVersionId] }),
    // "Show me this judge's verdicts over time" — the agreement timeline, and the
    // annotation queue's filter.
    index('trace_verdicts_judge_version_idx').on(table.judgeVersionId, table.createdAt),
  ],
)
