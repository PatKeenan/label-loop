import type { OpenAPIHono } from '@hono/zod-openapi'
import { Scalar } from '@scalar/hono-api-reference'
import type { AppEnv } from './app-env.ts'
import type { Config } from './config.ts'

/**
 * The integration surface is the documentation (ADR-0002): no SDK, so the spec and the
 * interactive reference *are* the client. The API-key security scheme is registered so
 * an integrator can paste a key into Scalar and call the API from the browser.
 */
export const API_KEY_SECURITY_SCHEME = 'apiKey' as const

export const mountDocs = (v1: OpenAPIHono<AppEnv>, config: Config): void => {
  v1.openAPIRegistry.registerComponent('securitySchemes', API_KEY_SECURITY_SCHEME, {
    type: 'http',
    scheme: 'bearer',
    description:
      'A per-panel API key, `llk_live_…` or `llk_test_…`, sent as ' +
      '`Authorization: Bearer <key>`. Every key is scoped to exactly one panel (ADR-0003).',
  })

  v1.doc('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'LabelLoop API',
      version: config.APP_VERSION,
      description:
        'Judge-as-a-service: send an artifact to a panel of judges and get back a ' +
        'decision plus one verdict per judge, each with its reasoning (ADR-0019). Every ' +
        'response is enveloped: `{ data, request_id }` on success, ' +
        '`{ error: { code, message }, request_id }` on failure.',
    },
    servers: [{ url: '/v1', description: 'Version 1' }],
  })

  v1.get('/docs', Scalar({ url: '/v1/openapi.json', pageTitle: 'LabelLoop API' }))
}
