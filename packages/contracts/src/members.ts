import { z } from 'zod'
import type { OrgRole } from './capabilities.ts'

/**
 * THE RULES FOR PUTTING A PERSON INTO AN ORGANISATION, defined once for both sides of the wire
 * (ADR-0065, ADR-0070) — the `names.ts` pattern: the API validates with these schemas and the
 * Members screen offers exactly these choices, so the form cannot promise what the server
 * refuses.
 */

/**
 * The roles an admin can grant, in the order a select lists them.
 *
 * `guest_expert` is NOT among them until M8 (ADR-0072): it grants no capability yet, so a
 * guest-expert member would be a person in the org who can do nothing, and the protections
 * that make guest access safe (time-boxing, panel scoping, PII masking) do not exist yet.
 */
export const GRANTABLE_ROLES = [
  'admin',
  'engineer',
  'annotator',
] as const satisfies readonly OrgRole[]
export type GrantableRole = (typeof GRANTABLE_ROLES)[number]

export const grantableRoleSchema = z.enum(GRANTABLE_ROLES)

/** One sentence per role, for the select — what it may DO, since that is what a role is (ADR-0064). */
export const ROLE_DESCRIPTIONS: Record<GrantableRole, string> = {
  admin: 'Everything, including who is in the organisation.',
  engineer: 'Panels, keys and traces. Can annotate.',
  annotator: 'Annotates traces. No keys, panels or trace list.',
}

/** An invitation is claimable for this long after it is made (ADR-0065). */
export const INVITATION_TTL_DAYS = 14

/**
 * The invited email: trimmed, lowercased, and a shape an inbox could have. Lowercased because
 * the claim compares it with the account's own email, and `Pat@Example.com` and
 * `pat@example.com` are one inbox. 254 is the longest address SMTP can carry.
 */
export const invitationEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'An email address is at most 254 characters.')
  .pipe(z.email('Enter an email address, like name@example.com.'))
