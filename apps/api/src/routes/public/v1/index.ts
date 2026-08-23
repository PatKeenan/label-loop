import { OpenAPIHono } from '@hono/zod-openapi'
import type { ErrorIssue } from '@labelloop/contracts'
import type { AppEnv } from '../../../app-env.ts'
import { AppError } from '../../../errors.ts'

/**
 * The public, versioned surface (CONVENTIONS.md "API rules"). Empty of endpoints at P2 —
 * classify arrives at P4 — but mounted now so that the spec, the security scheme and the
 * validation behaviour are all in place before the first endpoint can be written without
 * them.
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

export const createV1Routes = () =>
  new OpenAPIHono<AppEnv>({
    // Cast: @hono/zod-openapi types the hook against its own generic result shape; ours
    // is structurally the subset we actually read (success flag + Zod issues).
    defaultHook: validationHook as never,
  })
