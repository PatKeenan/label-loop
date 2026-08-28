import { text } from 'drizzle-orm/pg-core'
import { user } from './auth.ts'

/**
 * Who performed an authored act — created a panel, cut a version, issued a key.
 *
 * It references `user`, NOT `org_members`, and the cascade rules are what decide that.
 * `org_members` cascades from both `orgs` and `user`, so a membership row disappears the
 * moment someone leaves the org. Authorship pointed at membership would be deleted with
 * it, and authorship is a historical fact: the person who cut judge version 3 cut it
 * whether or not they still work there. The org is reachable anyway through the row's own
 * parents, so pointing at membership would also store the tenant twice.
 *
 * `ON DELETE RESTRICT` rather than `SET NULL`, and this is the load-bearing part. A
 * contributor keeps earning from a judge that is still in use after they leave the org
 * (decided 2026-08-24), so authorship is evidence the contribution ledger pays against.
 * `SET NULL` would destroy that evidence through a cascade rule rather than through a
 * decision — the deletion would look routine and the ledger would quietly lose a claim.
 * RESTRICT makes the invariant explicit: a user who authored something is not deletable.
 *
 * The policy that follows, and it is deliberate: users are ANONYMISED, never hard-deleted.
 * That is also what erasure actually requires — scrubbing personal data, not dropping the
 * row — so the ledger and the right to erasure do not have to be traded off. The mechanics
 * belong to M8's data-lifecycle work; this column is what makes the choice available.
 *
 * Nullable, because not every row has a human author: the seed creates rows, and once the
 * `manage` key scope lands (PRODUCT 5.1) an API key will create them too. A
 * `created_by_key_id` column can be added then with NO backfill, since no key-authored row
 * can exist before the scope does — which is why the polymorphic shape is not needed now.
 */
export const createdBy = () =>
  text('created_by').references(() => user.id, { onDelete: 'restrict' })
