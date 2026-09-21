import { createAccessControl } from 'better-auth/plugins/access'

/**
 * WHAT A ROLE MAY DO, defined once for both sides of the wire (ADR-0064, ADR-0068).
 *
 * A role answers what you may do, not what you see. The API guards every console route with
 * `requirePermission` against this map, and the console reads the same map to decide what to
 * offer — so the UI can never promise what the server refuses (the `names.ts` pattern). The
 * console mirrors; it never replaces the server's check.
 *
 * Built on better-auth's standalone `createAccessControl` (`better-auth/plugins/access`): pure,
 * table-free, ~60 lines in the installed 1.7.1 source. Not the organization plugin, which
 * ADR-0048 declined.
 */

/**
 * Every role an org membership can hold (PRODUCT.md 5.1, ADR-0014). The `org_role` Postgres
 * enum is built from THIS list, so the map below cannot miss a role: `Record<OrgRole, …>`
 * refuses to compile the day a fifth is added until someone decides what it may do.
 */
export const ROLES = ['admin', 'engineer', 'annotator', 'guest_expert'] as const
export type OrgRole = (typeof ROLES)[number]

/**
 * Every resource the console surface guards, and the actions on it.
 *
 * `annotation` carries two, and the split is the point (ADR-0083): `create` is answering a
 * trace, which an annotator does; `curate` is creating a set, topping it up, assigning people
 * to it and archiving it, which `admin` and `engineer` do and an annotator cannot.
 */
const statements = {
  panel: ['read', 'create'],
  key: ['read', 'issue', 'revoke'],
  model: ['read'],
  judge: ['read'],
  trace: ['read'],
  annotation: ['create', 'curate'],
  member: ['read', 'manage'],
} as const

type Statements = typeof statements
export type Resource = keyof Statements

/**
 * What a guard asks for: one or more resources, each with the actions it needs. Every action
 * named must be granted (AND) — a guard that needed only one of several would be two guards.
 */
export type PermissionRequest = {
  readonly [R in Resource]?: readonly Statements[R][number][]
}

const ac = createAccessControl(statements)

const grants = {
  admin: ac.newRole(statements),
  // Everything except managing members: an engineer builds panels and issues keys, but who
  // is in the org, and with what role, is the admin's call.
  engineer: ac.newRole({ ...statements, member: ['read'] }),
  // Annotation only, and NOT `curate`. No keys, no panel authoring, no trace list — an
  // annotator reads traces through their queue, which serves only what annotating needs
  // (ADR-0067). Choosing what somebody's afternoon is spent on is not the same act as
  // spending it, and assigning a set GRANTS read access to its traces (ADR-0083).
  annotator: ac.newRole({ annotation: ['create'] }),
  // Nothing until M8 (ADR-0072): guest access is time-boxed, panel-scoped and PII-masked,
  // and granting annotation without those hands an outsider every trace in the org.
  guest_expert: ac.newRole({}),
} satisfies Record<OrgRole, unknown>

/**
 * Whether `role` may do everything `request` names.
 *
 * Deny by default in every direction: an empty request, an unknown resource, and a role the
 * map does not know (only reachable by a cast) are all `false`.
 */
export const can = (role: OrgRole, request: PermissionRequest): boolean => {
  const grant = (grants as Partial<Record<string, (typeof grants)[OrgRole]>>)[role]
  if (grant === undefined || Object.keys(request).length === 0) return false
  return grant.authorize(request).success
}
