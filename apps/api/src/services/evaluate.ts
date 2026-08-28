import {
  type EvaluateRequest,
  type Evaluation,
  newId,
  parseId,
  type TraceId,
  type Verdict,
  type VerdictStatus,
} from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import { AppError } from '../errors.ts'
import type { JobQueue } from '../jobs/index.ts'
import { RECORD_EVALUATION } from '../jobs/index.ts'
import type { CallLogger, JudgeCallOutcome, ModelGateway } from '../llm/index.ts'
import type { AuthenticatedKey } from '../middleware/api-key-auth.ts'
import type { Clock } from '../ports/clock.ts'
import type { ErrorReporter } from '../ports/error-reporter.ts'
import { findLivePanel, type PanelJudge } from '../repositories/panels.ts'
import { insertTrace, type TraceVerdictRow } from '../repositories/traces.ts'

/**
 * Running a panel: the business logic behind `POST /v1/panels/{panel_id}/evaluate`, kept
 * out of the route so the route stays thin (CONVENTIONS.md "Directory shape").
 *
 * The shape of the work is: read the immutable configuration, fan the judges out in
 * parallel, turn each judge's raw answer into a scored verdict under its own polarity,
 * aggregate, persist, answer. The interesting decisions are all in the aggregation, and
 * they are marked below.
 */

export type EvaluationLogger = CallLogger & {
  /** Binds fields to every subsequent line of this request (hono-pino's child logger). */
  assign: (bindings: Record<string, unknown>) => void
}

export type EvaluateDeps = {
  db: Database
  clock: Clock
  gateway: ModelGateway
  errorReporter: ErrorReporter
  jobs: JobQueue
}

export type EvaluateCommand = {
  panelId: string
  apiKey: AuthenticatedKey
  request: EvaluateRequest
  /** The W3C id of this HTTP execution, stored on the trace row (ADR-0010). */
  requestId: string
  /** Accepted and logged; see the note in the route. */
  idempotencyKey?: string
}

/**
 * A judge's polarity applied to its raw answer — the single most important line in this
 * file (ADR-0019). `is-missing-repro: true` is a failure, `on-brand: true` is a success,
 * and `is-bug: true` is neither. Summing raw booleans across judges that mean opposite
 * things produces a number that looks meaningful and is not.
 */
const passedUnderPolarity = (
  polarity: PanelJudge['polarity'],
  verdict: boolean,
): boolean | null => {
  if (polarity === 'does_not_score') return null
  return polarity === 'passes' ? verdict : !verdict
}

/** Float sums drift; `score` is a contract field bounded at 0 and 1. Both are handled here. */
const clamp01 = (value: number): number => Math.min(1, Math.max(0, Math.round(value * 1e6) / 1e6))

type JudgeResult = { judge: PanelJudge; outcome: JudgeCallOutcome }

const statusOf = (outcome: JudgeCallOutcome): VerdictStatus => outcome.status

/**
 * Run one judge. `code` judges have no executor at M0 — the deterministic-check runtime
 * arrives with the taxonomy triage at M5 — so one is reported as `failed` rather than
 * quietly treated as a pass. `failed` is the honest status: the call did not produce a
 * usable answer, and retrying the identical request will not change that.
 */
const runJudge = async (
  deps: EvaluateDeps,
  judge: PanelJudge,
  request: EvaluateRequest,
  logger: EvaluationLogger,
): Promise<JudgeResult> => {
  if (judge.type === 'code' || judge.model === null) {
    logger.warn(
      { judge: judge.slug, judge_version_id: judge.judgeVersionId },
      'code judges are not executable yet (M5)',
    )
    return {
      judge,
      outcome: {
        status: 'failed',
        message: 'Deterministic `code` judges are not executable yet.',
        raw: undefined,
        attempts: 0,
        latencyMs: 0,
      },
    }
  }

  const outcome = await deps.gateway.judge(
    {
      model: judge.model,
      question: judge.question,
      artifact: request.artifact,
      ...(request.context === undefined ? {} : { context: request.context }),
    },
    { logger },
  )
  return { judge, outcome }
}

/**
 * Turn the judge results into the published `Evaluation`.
 *
 * Pure, and separate from everything that touches the network or the database, because
 * this is the part with the rules in it — and rules are worth testing without a Postgres.
 */
export const aggregate = (
  results: JudgeResult[],
  { threshold, panelVersionId }: { threshold: number; panelVersionId: string },
  traceId: TraceId,
): Evaluation => {
  const scoringConfigured = results.filter(({ judge }) => judge.polarity !== 'does_not_score')
  const contributing = scoringConfigured.filter(({ outcome }) => outcome.status === 'evaluated')

  // Weights are normalised across the judges that ACTUALLY scored, not across the ones
  // configured to. A judge that errored is absent from the denominator, which is what
  // makes `score` a real number over a smaller set rather than a diluted one over the
  // full set — and what makes `complete` the field that matters when reading it.
  const totalWeight = contributing.reduce((sum, { judge }) => sum + (judge.weight ?? 0), 0)

  const verdicts: Record<string, Verdict> = {}
  let score = 0
  let requiredHeld = true

  for (const { judge, outcome } of results) {
    const scoring = judge.polarity !== 'does_not_score'
    const share =
      scoring && outcome.status === 'evaluated' && totalWeight > 0
        ? (judge.weight ?? 0) / totalWeight
        : null

    const passed =
      outcome.status === 'evaluated'
        ? passedUnderPolarity(judge.polarity, outcome.output.verdict)
        : null

    if (passed === true && share !== null) score += share

    // A required judge is a veto: failing, being skipped, failing to answer or erroring
    // fails the panel outright, whatever the score says. That is how one policy expresses
    // "veto" without a second code path (ADR-0019).
    if (judge.required && (outcome.status !== 'evaluated' || passed === false)) {
      requiredHeld = false
    }

    verdicts[judge.slug] = {
      // Branded at the boundary rather than trusted. These strings come from Postgres,
      // where a CHECK constraint already guarantees the prefix — so this cannot fail in
      // practice, and if it ever does, an INTERNAL naming the row beats a malformed id in
      // a published response.
      judge_id: parseId('jud_', judge.judgeId),
      status: statusOf(outcome),
      error_code: outcome.status === 'error' ? outcome.code : null,
      rationale: outcome.status === 'evaluated' ? outcome.output.rationale : null,
      reasons: outcome.status === 'evaluated' ? outcome.output.reasons : [],
      verdict: outcome.status === 'evaluated' ? outcome.output.verdict : null,
      confidence: outcome.status === 'evaluated' ? outcome.output.confidence : null,
      passed,
      weight: share,
      served_by: outcome.status === 'evaluated' ? outcome.servedBy : null,
      latency_ms: outcome.latencyMs,
      attempts: outcome.attempts,
    }
  }

  const complete = scoringConfigured.length === contributing.length
  const finalScore = clamp01(score)

  return {
    // A panel with no scoring judges at all makes no claim to fail, so it passes on the
    // strength of its required judges alone. A panel that HAS scoring judges but got
    // nothing back from them does not reach this line — see `evaluate` below.
    passed: requiredHeld && (scoringConfigured.length === 0 || finalScore >= threshold),
    score: finalScore,
    complete,
    threshold,
    aggregation: { policy: 'weighted_threshold', panel_version: parseId('pnv_', panelVersionId) },
    judges: verdicts,
    trace_id: traceId,
  }
}

const toVerdictRows = (results: JudgeResult[], evaluation: Evaluation): TraceVerdictRow[] =>
  results.map(({ judge, outcome }) => {
    const verdict = evaluation.judges[judge.slug]
    return {
      judgeVersionId: judge.judgeVersionId,
      status: statusOf(outcome),
      verdict: verdict?.verdict ?? null,
      passed: verdict?.passed ?? null,
      rationale: verdict?.rationale ?? null,
      reasons: verdict?.reasons ?? [],
      confidence: verdict?.confidence ?? null,
      weight: verdict?.weight ?? null,
      servedBy: verdict?.served_by ?? null,
      latencyMs: outcome.latencyMs,
      attempts: outcome.attempts,
      // The provider's own payload, kept beside the normalised columns so a trace is
      // rerunnable and auditable rather than only as good as today's parser.
      rawResponse:
        outcome.status === 'evaluated'
          ? outcome.raw
          : outcome.status === 'failed'
            ? (outcome.raw ?? null)
            : null,
    }
  })

/**
 * Which failure a caller is told about when the panel could not decide at all. A refused
 * circuit is preferred because it is the only one that can say when to come back.
 */
const infrastructureFailure = (results: JudgeResult[]) => {
  const errored = results
    .map(({ outcome }) => outcome)
    .filter(
      (outcome): outcome is Extract<JudgeCallOutcome, { status: 'error' }> =>
        outcome.status === 'error',
    )
  return errored.find((outcome) => outcome.retryAfterSeconds !== undefined) ?? errored[0]
}

/**
 * Hand the evaluation's follow-up to the queue — exactly one job, carrying the two ids
 * that make its log lines findable (ADR-0010).
 *
 * **A failed enqueue does not fail the request**, and the reason is that the request has
 * already succeeded: the judges ran, the trace is committed, and the caller is owed the
 * verdicts. Refusing them because a background job could not be queued would turn a
 * degraded dependency into an outage on the one path that was working.
 *
 * The cost is a job that is dropped rather than deferred, and it is bounded rather than
 * hidden: the work is idempotent and its completion is a nullable column, so an evaluation
 * whose follow-up never ran is `traces.recorded_at IS NULL` — a query, and the shape a
 * reconciliation sweep takes when M2's metering makes one worth writing.
 *
 * The alternative is enqueueing inside the trace's transaction, which is the right answer
 * and is currently unavailable: see the P5 deviation record on pg-boss's transactional
 * `send` under Bun's Postgres driver.
 */
const enqueueFollowUp = async (
  deps: EvaluateDeps,
  traceId: TraceId,
  requestId: string,
  logger: EvaluationLogger,
): Promise<void> => {
  try {
    const jobId = await deps.jobs.send(RECORD_EVALUATION, {
      trace_id: traceId,
      request_id: requestId,
    })
    logger.info({ queue: RECORD_EVALUATION, job_id: jobId }, 'job enqueued')
  } catch (error) {
    logger.error({ queue: RECORD_EVALUATION, err: error }, 'job could not be enqueued')
    deps.errorReporter.report(error, {
      requestId,
      context: { queue: RECORD_EVALUATION, trace_id: traceId },
    })
  }
}

export const evaluate = async (
  deps: EvaluateDeps,
  command: EvaluateCommand,
  logger: EvaluationLogger,
): Promise<Evaluation> => {
  const panel = await findLivePanel(deps.db, command.panelId)
  if (panel === undefined) {
    throw new AppError('NOT_FOUND', 'This panel has no live version to evaluate against.')
  }
  if (panel.judges.length === 0) {
    throw new AppError('NOT_FOUND', 'This panel version convenes no judges.')
  }

  // Minted here, before the row exists, and bound to the logger immediately. CONVENTIONS
  // asks for the `tr_` id on evaluation-path lines "once the row exists" — but the row
  // cannot exist yet: its `passed`, `score` and `complete` columns are NOT NULL and are
  // not known until every judge has answered. Minting the id in the application (which is
  // why `packages/db` generates ids there rather than by a database default) gets the same
  // property one step earlier: every judge-call and retry line for this evaluation carries
  // the id of the trace they will end up in.
  const traceId = newId('tr_', deps.clock.now())
  logger.assign({ trace_id: traceId })

  logger.info(
    {
      panel_id: panel.panelId,
      panel_version_id: panel.panelVersionId,
      judges: panel.judges.length,
      ...(command.idempotencyKey === undefined ? {} : { idempotency_key: command.idempotencyKey }),
    },
    'evaluation started',
  )

  // In parallel: judges are independent by construction — one judge, one failure category,
  // never bundled into one multi-criteria prompt (ADR-0019) — so the panel's latency is
  // its slowest judge rather than the sum of all of them.
  const results = await Promise.all(
    panel.judges.map((judge) => runJudge(deps, judge, command.request, logger)),
  )

  for (const { judge, outcome } of results) {
    if (outcome.status === 'error' && outcome.code === 'INTERNAL') {
      // An adapter that broke its own contract is a bug in our code, and reporting is not
      // handling (ADR-0007): the tracker is told, and the caller still gets a verdict.
      deps.errorReporter.report(outcome.cause, {
        requestId: command.requestId,
        context: { judge: judge.slug, trace_id: traceId },
      })
    }
  }

  const evaluation = aggregate(results, panel, traceId)

  await insertTrace(
    deps.db,
    {
      id: traceId,
      orgId: panel.orgId,
      panelId: panel.panelId,
      panelVersionId: panel.panelVersionId,
      apiKeyId: command.apiKey.id,
      requestId: command.requestId,
      artifact: command.request.artifact,
      context: command.request.context ?? null,
      passed: evaluation.passed,
      score: evaluation.score,
      complete: evaluation.complete,
      threshold: evaluation.threshold,
    },
    toVerdictRows(results, evaluation),
  )

  await enqueueFollowUp(deps, traceId, command.requestId, logger)

  const evaluated = results.filter(({ outcome }) => outcome.status === 'evaluated')
  const scoringConfigured = panel.judges.filter((judge) => judge.polarity !== 'does_not_score')
  const scored = results.filter(
    ({ judge, outcome }) => judge.polarity !== 'does_not_score' && outcome.status === 'evaluated',
  )

  /**
   * The panel could not decide, and saying so is the honest answer.
   *
   * A partial result is returned whenever SOME scoring judge answered: the published
   * contract calls that "real but partial", and `complete: false` is how a caller sees it.
   * When the denominator is empty there is no partial number to report — `score: 0` would
   * read as "everything failed", and a gate acting on `passed: false` would block a
   * perfectly good artifact because our provider was down. So an infrastructure failure
   * with nothing to divide by fails the request, retryably, with the code that says why.
   *
   * The trace row is written FIRST, deliberately. The run happened, it is the run somebody
   * will want to look at, and the error envelope carries the `request_id` that the trace
   * row also stores — so the record is reachable even though the response has no `data`.
   */
  const nothingUsable =
    evaluated.length === 0 || (scoringConfigured.length > 0 && scored.length === 0)
  const failure = nothingUsable ? infrastructureFailure(results) : undefined
  if (failure !== undefined) {
    logger.warn({ code: failure.code }, 'evaluation could not be completed')
    throw new AppError(failure.code, 'No judge on this panel could be reached.', {
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: failure.retryAfterSeconds }),
    })
  }

  logger.info(
    {
      passed: evaluation.passed,
      score: evaluation.score,
      complete: evaluation.complete,
      judges_evaluated: evaluated.length,
    },
    'evaluation completed',
  )

  return evaluation
}
