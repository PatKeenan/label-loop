import type { Catalogue, CatalogueModel, ModelEndpoints } from '../llm/catalogue.ts'

/**
 * A catalogue stand-in for the tests that are not about the catalogue.
 *
 * Most of the API's tests are about routing, the envelope and the logger; giving them a real
 * catalogue would mean an outbound request to a provider on every `createApp`, which is the
 * one thing `architecture.test.ts` exists to keep rare and deliberate. It answers the two
 * calls the app makes and nothing else.
 *
 * The tests that ARE about the catalogue use the real client with an injected `fetch` and the
 * recorded fixtures, in `llm/catalogue.test.ts`.
 */

export type FakeCatalogueOptions = {
  models?: CatalogueModel[]
  /** Answer as a cold start with no network: an explicit reason, never an empty list. */
  unavailable?: boolean
  endpoints?: Partial<ModelEndpoints>
}

export const fakeCatalogue = ({
  models = [],
  unavailable = false,
  endpoints,
}: FakeCatalogueOptions = {}): Catalogue => ({
  list: async () =>
    unavailable
      ? { ok: false, reason: 'the fake catalogue was asked to be unavailable' }
      : {
          ok: true,
          snapshot: { models, fetchedAt: new Date(0).toISOString(), stale: false },
        },
  endpointsFor: async (modelId) =>
    unavailable
      ? { ok: false, reason: 'the fake catalogue was asked to be unavailable' }
      : {
          ok: true,
          endpoints: {
            modelId,
            total: 0,
            byQuantization: {},
            fetchedAt: new Date(0).toISOString(),
            stale: false,
            ...endpoints,
          },
        },
})
