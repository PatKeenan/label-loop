import { OpenAPIHono } from '@hono/zod-openapi'
import type { ErrorIssue } from '@labelloop/contracts'
import type { AppEnv } from '../../../app-env.ts'
import { AppError } from '../../../errors.ts'
import { createEvaluateRoutes } from './evaluate.ts'

/**
 * The public, versioned surface (CONVENTIONS.md "API rules"). It was mounted empty at P2
 * so that the spec, the security scheme and the validation behaviour were all in place
 * before the first endpoint could be written without them; P4 adds that endpoint.
 */

/** Flatten a Zod failure into the envelope's `issues[]`. */
export const toErrorIssues = (error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>
}): ErrorIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))

/**
 * Contract-validation failures auto-map to `VALIDATION_ERROR` (CONVENTIONS.md). This
 * hook is what makes that automatic: every route built with `createRoute` gets it, so no
 * endpoint has to remember, and 422 responses are identical in shape across the API.
 */
export const validationHook = (
  result:
    | { success: true }
    | {
        success: false
        error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }
      },
) => {
  if (result.success) return
  throw new AppError('VALIDATION_ERROR', 'The request failed validation.', {
    issues: toErrorIssues(result.error),
  })
}

export const createV1Routes = () => {
  const v1 = new OpenAPIHono<AppEnv>({
    // Cast: @hono/zod-openapi types the hook against its own generic result shape; ours
    // is structurally the subset we actually read (success flag + Zod issues).
    defaultHook: validationHook as never,
  })

  // Mounted through `route`, not defined here, so each endpoint owns its own file and the
  // OpenAPI registry is merged rather than centralised.
  v1.route('/', createEvaluateRoutes())

  return v1
}
