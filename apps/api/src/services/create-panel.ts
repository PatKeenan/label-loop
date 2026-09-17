import { type ModelPin, newId } from '@labelloop/contracts'
import type { Database } from '@labelloop/db'
import type { ModelProvider } from '../llm/provider.port.ts'
import { validatePin } from '../llm/validate-pin.ts'
import type { Clock } from '../ports/clock.ts'
import { recordAuditEvent } from '../repositories/audit-events.ts'
import {
  activatePanelVersion,
  insertJudge,
  insertJudgeVersion,
  insertPanel,
  insertPanelVersion,
  linkPanelVersionJudge,
} from '../repositories/panels.ts'
import { type IssuedApiKey, issueApiKeyOn } from './api-keys.ts'

/**
 * Creating a panel and its judges — **the first write path for immutable versions** outside
 * `scripts/seed.ts`.
 *
 * It is boxed in by Postgres, and the box is the design:
 *
 * - **There is no draft row.** Migration 0005 revokes UPDATE and DELETE from the app role on
 *   both version tables, so a version is written once and finished. The wizard's draft is
 *   client state until submit (ADR-0052); this function is the submit.
 * - **The pin is proven before anything is written** (ADR-0026). After the `jdv_` exists its
 *   pin is frozen, so a pin that routes nowhere would be a permanently broken judge.
 * - **Everything lands in one transaction, or nothing does.** A panel with a version and no
 *   judges reads as a panel whose judges were deleted; an activated pointer at a version with
 *   no membership rows serves a panel that judges nothing. Both look like a configuration
 *   rather than like corruption, which is what makes a half-written panel dangerous.
 *
 * **Validation happens OUTSIDE the transaction, and before it opens.** That is a deliberate
 * reading of "validate every pin before insert": a validating call is a real network round
 * trip to a provider — measured at 3.3 seconds for one haiku probe — and holding a database
 * transaction open across N of them would pin a pooled connection and its locks for the whole
 * wait. So every pin is validated first; if any fails, no transaction is ever opened and there
 * is nothing to roll back. `scripts/seed.ts` has done the same since M1.
 */

/**
 * A judge as the wizard submits it — and there is no `type` field, because M4 can only create
 * `llm` judges honestly.
 *
 * **`code` judges are refused, and not by omission.** `services/evaluate.ts` has no executor
 * for them until M5's taxonomy triage, so every one reports `failed` on every evaluation. The
 * schema also has no column for what a code judge would CHECK — no assertion, no regex — so
 * one created now is a judge with no definition that can never run. Worse, marked `required`
 * it would veto its panel on every call, and because versions are immutable the only way out
 * would be writing a new panel version. The route rejects `type: 'code'` with a message
 * saying so; this type makes the service unable to receive one at all.
 */
export type NewJudgeInput = {
  slug: string
  name: string
  question: string
  polarity: 'passes' | 'fails'
  weight: number
  required: boolean
  /** Route-qualified, e.g. `openrouter:anthropic/claude-fable-5.1` or `fake:deterministic`. */
  model: string
  pin: ModelPin
}

export type CreatePanelInput = {
  db: Database
  clock: Clock
  /** The registry, not the gateway — an unsatisfiable pin is an answer, not an outage. */
  provider: ModelProvider
  orgId: string
  actorId: string | null
  requestId: string | null
  panel: { slug: string; name: string; threshold: number }
  /**
   * May be EMPTY (ADR-0060). A panel with no judges is created COLLECTING: it accepts calls,
   * captures every trace and convenes nobody. That is the normal state of a new panel since
   * ADR-0061 moved judge authoring behind an eval pass, not an edge case — the console never
   * sends judges at M4, and this path stays for seeding and tests until M6 replaces it.
   */
  judges: NewJudgeInput[]
  /**
   * Issue a key WITH the panel, in the same transaction.
   *
   * One act rather than two, because the console's onboarding screen hands the person a
   * runnable snippet and a snippet needs a credential in it. Two steps would allow a panel
   * that exists with no key, stranding someone on that screen; the transaction makes that
   * state unrepresentable instead of recoverable.
   */
  key?: { name: string; nodeEnv: string }
}

export type CreatedJudge = {
  judgeId: string
  judgeVersionId: string
  slug: string
  availableEndpoints: number
  servedBy: string
}

/** One judge whose pin could not be satisfied, located so the wizard can render it in place. */
export type PinFailure = { index: number; slug: string; reason: string }

export type CreatePanelResult =
  | {
      ok: true
      panelId: string
      panelVersionId: string
      judges: CreatedJudge[]
      /** Present only when `key` was asked for. Its plaintext exists exactly once. */
      key?: IssuedApiKey
    }
  /**
   * EVERY failing judge, not the first. Reporting one at a time would have a person fix it,
   * resubmit, and pay for the other judges' validating calls again — only to learn the next
   * one was also wrong.
   */
  | { ok: false; kind: 'unsatisfiable_pins'; failures: PinFailure[] }
  /** The org already has a panel with this slug (`panels_org_slug_key`). */
  | { ok: false; kind: 'slug_taken' }

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505'

/**
 * The one unique index a well-formed request can hit, because it depends on what already
 * exists in the org. Named rather than matched on SQLSTATE alone: `judges_panel_slug_key`
 * raises the same 23505, and reporting a duplicate JUDGE slug as "that panel slug is taken"
 * would send someone to fix the wrong field. The route rejects duplicate judge slugs before
 * they get here; this makes the service correct without relying on that.
 */
const PANEL_SLUG_CONSTRAINT = 'panels_org_slug_key'

/** Drizzle may wrap the driver's error, so both depths are read. */
const pgErrorOf = (error: unknown): { code?: string; constraint?: string } | undefined => {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    if (typeof candidate === 'object' && candidate !== null && 'code' in candidate) {
      const { code, constraint } = candidate as { code: unknown; constraint?: unknown }
      return {
        code: String(code),
        ...(typeof constraint === 'string' ? { constraint } : {}),
      }
    }
  }
  return undefined
}

export const createPanel = async ({
  db,
  clock,
  provider,
  orgId,
  actorId,
  requestId,
  panel,
  judges,
  key,
}: CreatePanelInput): Promise<CreatePanelResult> => {
  const now = () => new Date(clock.now())

  // ── 1. Prove every pin, before any transaction exists ────────────────────────────────────
  // In parallel: a wizard with three judges would otherwise wait for three sequential
  // provider round trips. Each call is independent, and `validatePin` returns rather than
  // throws, so one failure cannot abort the others.
  const validations = await Promise.all(
    judges.map((judge) => validatePin({ provider, model: judge.model, pin: judge.pin, now })),
  )

  const failures: PinFailure[] = validations.flatMap((result, index) =>
    result.ok ? [] : [{ index, slug: judges[index]?.slug ?? '', reason: result.reason }],
  )
  if (failures.length > 0) return { ok: false, kind: 'unsatisfiable_pins', failures }

  // ── 2. Write it all, or none of it ──────────────────────────────────────────────────────
  const panelId = newId('pnl_', clock.now())
  const panelVersionId = newId('pnv_', clock.now())
  const actorType = actorId === null ? 'system' : 'user'

  try {
    const created = await db.transaction(async (tx) => {
      // Order is the one the seed proved legal, and it is not arbitrary: every row below
      // references one written above it.
      await insertPanel(tx, {
        id: panelId,
        orgId,
        slug: panel.slug,
        name: panel.name,
        createdBy: actorId,
      })
      await insertPanelVersion(tx, {
        id: panelVersionId,
        panelId,
        version: 1,
        threshold: panel.threshold,
        createdBy: actorId,
      })

      const createdJudges: CreatedJudge[] = []
      for (const [index, judge] of judges.entries()) {
        const validation = validations[index]
        // Unreachable — every failure returned above — but narrowed rather than asserted, so
        // a future change to that early return cannot write a judge with no validation.
        if (validation === undefined || !validation.ok) {
          throw new Error(`judge ${index} reached the write phase without a validated pin`)
        }

        const judgeId = newId('jud_', clock.now())
        const judgeVersionId = newId('jdv_', clock.now())

        await insertJudge(tx, {
          id: judgeId,
          panelId,
          slug: judge.slug,
          name: judge.name,
          createdBy: actorId,
        })
        await insertJudgeVersion(tx, {
          id: judgeVersionId,
          judgeId,
          version: 1,
          polarity: judge.polarity,
          weight: judge.weight,
          required: judge.required,
          question: judge.question,
          model: judge.model,
          modelPin: judge.pin,
          // The measurement taken once, before the row froze (ADR-0026) — its own column,
          // never merged into the pin, because one is a constraint and one is an observation.
          modelPinValidation: validation.validation,
          createdBy: actorId,
        })
        await linkPanelVersionJudge(tx, panelVersionId, judgeVersionId)

        await recordAuditEvent(tx, {
          orgId,
          actorType,
          actorId,
          action: 'judge_version.created',
          subjectType: 'judge_version',
          subjectId: judgeVersionId,
          // The configuration fields that answer "what changed", and NOT the question text.
          // The question is unbounded customer prose and the audit log is permanent and
          // exported (M8); the immutable row holds it, and `subject_id` points there.
          data: {
            judge_id: judgeId,
            panel_version_id: panelVersionId,
            slug: judge.slug,
            version: 1,
            model: judge.model,
            polarity: judge.polarity,
            weight: judge.weight,
            required: judge.required,
          },
          requestId,
        })

        createdJudges.push({
          judgeId,
          judgeVersionId,
          slug: judge.slug,
          availableEndpoints: validation.validation.available_endpoints,
          servedBy: validation.validation.served_by,
        })
      }

      // Activation, last. Two claims here, and only one of them is load-bearing:
      //
      // - The VERSION ROW must exist first. That one is real and Postgres enforces it — the
      //   pointer's composite foreign key refuses a version that has not been written.
      // - Doing it after the JUDGES is ordering for the reader, not for correctness. An
      //   earlier draft of this comment claimed a pointer moved sooner "would briefly serve an
      //   empty panel", and a mutation disproved it: activating before the judge loop passes
      //   every test, because inside a transaction nothing outside can see the intermediate
      //   state — READ COMMITTED readers see the pointer and the judges together or neither.
      //   The guarantee is the TRANSACTION, and removing it is what the tests do catch.
      //   Keeping this last still matters in one case: if this is ever split out of the
      //   transaction, the order becomes the only thing standing between a reader and an empty
      //   panel.
      await activatePanelVersion(tx, panelId, panelVersionId, now())

      await recordAuditEvent(tx, {
        orgId,
        actorType,
        actorId,
        action: 'panel_version.created',
        subjectType: 'panel_version',
        subjectId: panelVersionId,
        data: {
          panel_id: panelId,
          slug: panel.slug,
          version: 1,
          threshold: panel.threshold,
          judge_version_ids: createdJudges.map((judge) => judge.judgeVersionId),
          // Recorded because activation is a pointer move, and a pointer that slides leaves
          // no trace on the row it points at. This is the trace.
          activated: true,
        },
        requestId,
      })

      // The key, LAST and inside the same transaction. Last because it references the panel;
      // inside because a panel whose key failed would leave someone on the onboarding screen
      // with a snippet and nothing to authenticate it.
      const issued =
        key === undefined
          ? undefined
          : await issueApiKeyOn(tx, {
              clock,
              nodeEnv: key.nodeEnv,
              orgId,
              panelId,
              name: key.name,
              actorId,
              requestId,
            })

      return { createdJudges, issued }
    })

    return {
      ok: true,
      panelId,
      panelVersionId,
      judges: created.createdJudges,
      ...(created.issued === undefined ? {} : { key: created.issued }),
    }
  } catch (error) {
    // The one constraint a well-formed request can still hit, because it depends on what
    // already exists. Anything else is unexpected and propagates to the central handler.
    const pg = pgErrorOf(error)
    if (pg?.code === UNIQUE_VIOLATION && pg.constraint === PANEL_SLUG_CONSTRAINT) {
      return { ok: false, kind: 'slug_taken' }
    }
    throw error
  }
}
