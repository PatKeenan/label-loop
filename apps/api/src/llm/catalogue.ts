import { REASONING_EFFORTS, type ReasoningEffort } from '@labelloop/contracts'
import type { Clock } from '../ports/clock.ts'

/**
 * The provider's model catalogue: what the picker is POPULATED from (ADR-0053, ADR-0054).
 *
 * **It must live in `src/llm/`**, and that is enforced rather than remembered: ADR-0016's
 * `architecture.test.ts` fails the build on a provider hostname or an outbound `fetch`
 * anywhere else in the repository.
 *
 * **What it may not do is the load-bearing part.** The catalogue POPULATES; ADR-0026's real
 * validating call GATES. Three claims it is specifically forbidden from making, each measured
 * rather than reasoned about (`thoughts/shared/research/2026-08-30_model-tier-measurements.md`):
 *
 * - **`supported_parameters` is not a guarantee.** It is a UNION across a model's endpoints —
 *   `claude-sonnet-5` advertised structured output while three of its nine endpoints could not
 *   do it. So this file surfaces the flag as INFORMATION and never as a gate.
 *
 *   (The companion example — `claude-haiku-4.5` breaking the output contract 4 of 4 times on
 *   2026-08-30 — is HISTORICAL: the cap that caused it was split on 2026-08-31 and haiku now
 *   passes, re-verified 2026-09-13. See ADR-0053. The union argument above is the one that
 *   still stands on its own, and it is the reason this file gates nothing.)
 * - **`reasoning.mandatory` does not mean "this model always reasons."** That would be false
 *   for `gemini-3.5-flash-lite`, which is `mandatory: true` and reported **0 reasoning tokens
 *   at `minimal` across three runs** — and is the cheapest, fastest model measured. The flag
 *   is passed through unchanged; the console must not translate it into a warning.
 * - **Nothing here knows about `data_collection`.** No catalogue field exposes a data policy
 *   (ADR-0023), so its effect on the endpoint pool is knowable only by asking.
 *
 * **The cache is in-memory with a TTL and a last-good snapshot** (ADR-0054) — over a Postgres
 * snapshot with a refresh job, which buys restart survival at the cost of a table, a migration
 * and a job handler. The consequence is stated rather than hidden: a cold start with no network
 * has nothing to serve, and says so explicitly instead of returning an empty list that looks
 * like a provider with no models.
 */

/** Public and unauthenticated: the catalogue is not a credentialed read. */
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1'

/** Long enough that a wizard session costs one fetch; short enough to notice a new model. */
const DEFAULT_TTL_MS = 15 * 60 * 1000

/** A catalogue read is not on anybody's hot path, and a hung one must not hold the console. */
const DEFAULT_TIMEOUT_MS = 10_000

/**
 * One candidate, in the terms the picker actually needs.
 *
 * **There is no endpoint count here, and that is a decision.** `/models` does not carry one —
 * verified against the live catalogue, 445 models and no such field — so populating it would
 * mean one HTTP call per model per refresh. It is also the wrong number: the count that
 * matters is how many endpoints survive THIS judge's pin, which only ADR-0026's validating
 * call can answer. `endpointsFor()` below serves the raw count for one model on demand.
 */
export type CatalogueModel = {
  /** Route-qualified as the provider names it, e.g. `anthropic/claude-fable-5.1`. */
  id: string
  name: string
  /**
   * USD per TOKEN, as the provider publishes it — a decimal string, not a number. Parsing it
   * to a float here would throw away precision for a value that is later multiplied by a
   * token count, the same reasoning ADR-0027 applies to stored costs. Null when unpriced,
   * which is a real state: a free model and a model whose price nobody published both exist.
   */
  promptUsd: string | null
  completionUsd: string | null
  /** Passed through unchanged. See the warning above: this is not "always reasons". */
  reasoningMandatory: boolean
  /** Narrowed to the efforts a pin can express; anything else the provider lists is dropped. */
  supportedEfforts: ReasoningEffort[]
  defaultEffort: ReasoningEffort | null
  /** Advertised, NOT guaranteed. Shown as information; never used to gate. */
  advertisesStructuredOutput: boolean
}

export type CatalogueSnapshot = {
  models: CatalogueModel[]
  fetchedAt: string
  /**
   * True when this snapshot is being served because a refresh FAILED, not because it is
   * fresh. The console shows it as "last updated at…" rather than silently presenting stale
   * prices as current.
   */
  stale: boolean
}

export type CatalogueResult =
  | { ok: true; snapshot: CatalogueSnapshot }
  /**
   * A cold start with no network. **An explicit reason, never an empty list** — the two are
   * indistinguishable to a wizard that renders `models.map(...)`, and one of them means "this
   * provider has no models" while the other means "we could not ask".
   */
  | { ok: false; reason: string }

export type ModelEndpoints = {
  modelId: string
  /** How many endpoints exist AT ALL, before any pin narrows them. */
  total: number
  /**
   * Quantization as declared, counted. `unknown` is its own bucket and deliberately not
   * merged into anything: across one open-weights model's 20 endpoints the split was fp4 ×1,
   * fp8 ×12 and unstated ×7, and pinning a precision drops every endpoint that merely did not
   * say. The console shows what constraining it COSTS in failover, which needs this bucket.
   */
  byQuantization: Record<string, number>
  fetchedAt: string
  stale: boolean
}

export type Catalogue = {
  /** Every candidate. Cached for the TTL; serves the last good snapshot if a refresh fails. */
  list: () => Promise<CatalogueResult>
  /** Raw endpoint detail for ONE model, fetched and cached on demand. */
  endpointsFor: (
    modelId: string,
  ) => Promise<{ ok: true; endpoints: ModelEndpoints } | { ok: false; reason: string }>
}

export type CatalogueOptions = {
  clock: Clock
  /** Injected (ADR-0028) so every test here runs offline and deterministically. */
  fetch?: typeof globalThis.fetch
  baseUrl?: string
  ttlMs?: number
  timeoutMs?: number
  /** Where a failed refresh is reported. Degraded-but-serving is `warn`, per CONVENTIONS. */
  logger?: { warn: (obj: object, msg: string) => void }
}

/** The provider's wire shape, narrowed to what is read. Everything optional: it is theirs. */
type WireModel = {
  id?: unknown
  name?: unknown
  pricing?: { prompt?: unknown; completion?: unknown }
  reasoning?: { mandatory?: unknown; supported_efforts?: unknown; default_effort?: unknown }
  supported_parameters?: unknown
}

const isEffort = (value: unknown): value is ReasoningEffort =>
  typeof value === 'string' && (REASONING_EFFORTS as readonly string[]).includes(value)

/** A price is a decimal string or nothing. `"0"` is a real answer and is kept as one. */
const priceOf = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const toModel = (raw: WireModel): CatalogueModel | undefined => {
  if (typeof raw.id !== 'string' || raw.id === '') return undefined
  const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : []
  const efforts = Array.isArray(raw.reasoning?.supported_efforts)
    ? raw.reasoning.supported_efforts
    : []
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : raw.id,
    promptUsd: priceOf(raw.pricing?.prompt),
    completionUsd: priceOf(raw.pricing?.completion),
    reasoningMandatory: raw.reasoning?.mandatory === true,
    // Efforts the provider lists that no pin can express are dropped rather than surfaced:
    // offering one would produce a judge whose pin cannot be written down.
    supportedEfforts: efforts.filter(isEffort),
    defaultEffort: isEffort(raw.reasoning?.default_effort) ? raw.reasoning.default_effort : null,
    advertisesStructuredOutput: parameters.includes('structured_outputs'),
  }
}

type WireEndpoint = { quantization?: unknown }

export const createCatalogue = ({
  clock,
  fetch = globalThis.fetch,
  baseUrl = DEFAULT_BASE_URL,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger,
}: CatalogueOptions): Catalogue => {
  let models: { snapshot: CatalogueSnapshot; expiresAt: number } | undefined
  const endpoints = new Map<string, { value: ModelEndpoints; expiresAt: number }>()

  const getJson = async (path: string): Promise<unknown> => {
    // Its own timeout, because the console asking "what models exist" must not be able to
    // hang on a provider that has stopped answering.
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new Error(`catalogue responded ${response.status}`)
    return response.json()
  }

  return {
    list: async () => {
      const now = clock.now()
      if (models !== undefined && now < models.expiresAt) {
        return { ok: true, snapshot: models.snapshot }
      }

      try {
        const body = (await getJson('/models')) as { data?: unknown }
        const rows = Array.isArray(body.data) ? (body.data as WireModel[]) : []
        const snapshot: CatalogueSnapshot = {
          models: rows.map(toModel).filter((model): model is CatalogueModel => model !== undefined),
          fetchedAt: new Date(now).toISOString(),
          stale: false,
        }
        models = { snapshot, expiresAt: now + ttlMs }
        return { ok: true, snapshot }
      } catch (error) {
        // Degraded but serving: a stale price list is worth more to a picker than nothing,
        // as long as it is LABELLED stale rather than presented as current.
        if (models !== undefined) {
          logger?.warn(
            { err: error instanceof Error ? error.message : 'unknown' },
            'model catalogue refresh failed; serving the last good snapshot',
          )
          const snapshot = { ...models.snapshot, stale: true }
          // The failed attempt is not retried on every keystroke; the TTL restarts.
          models = { snapshot, expiresAt: now + ttlMs }
          return { ok: true, snapshot }
        }
        logger?.warn(
          { err: error instanceof Error ? error.message : 'unknown' },
          'model catalogue is unavailable and there is no previous snapshot',
        )
        return {
          ok: false,
          reason:
            'The model catalogue could not be reached, and nothing has been fetched yet. ' +
            'Model choices are unavailable until it answers.',
        }
      }
    },

    endpointsFor: async (modelId) => {
      const now = clock.now()
      const cached = endpoints.get(modelId)
      if (cached !== undefined && now < cached.expiresAt) {
        return { ok: true, endpoints: cached.value }
      }

      try {
        const body = (await getJson(`/models/${modelId}/endpoints`)) as {
          data?: { endpoints?: unknown }
        }
        const rows = Array.isArray(body.data?.endpoints)
          ? (body.data.endpoints as WireEndpoint[])
          : []
        const byQuantization: Record<string, number> = {}
        for (const row of rows) {
          const key = typeof row.quantization === 'string' ? row.quantization : 'unknown'
          byQuantization[key] = (byQuantization[key] ?? 0) + 1
        }
        const value: ModelEndpoints = {
          modelId,
          total: rows.length,
          byQuantization,
          fetchedAt: new Date(now).toISOString(),
          stale: false,
        }
        endpoints.set(modelId, { value, expiresAt: now + ttlMs })
        return { ok: true, endpoints: value }
      } catch (error) {
        if (cached !== undefined) {
          const value = { ...cached.value, stale: true }
          endpoints.set(modelId, { value, expiresAt: now + ttlMs })
          return { ok: true, endpoints: value }
        }
        logger?.warn(
          { model: modelId, err: error instanceof Error ? error.message : 'unknown' },
          'model endpoints are unavailable and there is no previous snapshot',
        )
        return { ok: false, reason: 'Endpoint detail for this model could not be reached.' }
      }
    },
  }
}
