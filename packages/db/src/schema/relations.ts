import { relations } from 'drizzle-orm'
import { apiKeys } from './api-keys.ts'
import { auditEvents } from './audit-events.ts'
import { account, session, user } from './auth.ts'
import { judgeVersions } from './judge-versions.ts'
import { judges } from './judges.ts'
import { orgMembers } from './org-members.ts'
import { orgs } from './orgs.ts'
import { panelVersionJudges } from './panel-version-judges.ts'
import { panelVersions } from './panel-versions.ts'
import { panels } from './panels.ts'
import { traceVerdicts } from './trace-verdicts.ts'
import { traces } from './traces.ts'

/**
 * The relation graph, for Drizzle's relational query API.
 *
 * `relations()` is NOT what creates the foreign keys — `.references()` on each column does
 * that, and those constraints are what the database actually enforces. This is a
 * separate, TypeScript-level declaration that teaches `db.query.<table>.findMany({ with: … })`
 * how tables connect. Declaring the constraints without declaring these leaves the query
 * API in a trap: `db.query.panels` exists and a plain `findMany()` works, so it looks
 * wired, and the first `with:` fails at RUNTIME rather than at typecheck.
 * `relations.test.ts` traverses the whole graph so that cannot regress quietly.
 *
 * They live in one file rather than beside each table because the graph is inherently
 * circular — orgs reference panels and panels reference orgs — and co-locating them would
 * mean a module cycle per edge. One file also means the shape of the domain is readable in
 * one screen, which is worth more than proximity here.
 */

export const orgsRelations = relations(orgs, ({ many }) => ({
  members: many(orgMembers),
  panels: many(panels),
  apiKeys: many(apiKeys),
  traces: many(traces),
  auditEvents: many(auditEvents),
}))

export const orgMembersRelations = relations(orgMembers, ({ one }) => ({
  org: one(orgs, { fields: [orgMembers.orgId], references: [orgs.id] }),
  user: one(user, { fields: [orgMembers.userId], references: [user.id] }),
}))

export const panelsRelations = relations(panels, ({ one, many }) => ({
  org: one(orgs, { fields: [panels.orgId], references: [orgs.id] }),
  judges: many(judges),
  versions: many(panelVersions),
  apiKeys: many(apiKeys),
  traces: many(traces),
}))

export const panelVersionsRelations = relations(panelVersions, ({ one, many }) => ({
  panel: one(panels, { fields: [panelVersions.panelId], references: [panels.id] }),
  /** The pinned judge set. Traversed through the join table, never inferred from `judges`. */
  judgeVersions: many(panelVersionJudges),
  traces: many(traces),
}))

export const judgesRelations = relations(judges, ({ one, many }) => ({
  panel: one(panels, { fields: [judges.panelId], references: [panels.id] }),
  versions: many(judgeVersions),
}))

export const judgeVersionsRelations = relations(judgeVersions, ({ one, many }) => ({
  judge: one(judges, { fields: [judgeVersions.judgeId], references: [judges.id] }),
  panelVersions: many(panelVersionJudges),
  verdicts: many(traceVerdicts),
}))

export const panelVersionJudgesRelations = relations(panelVersionJudges, ({ one }) => ({
  panelVersion: one(panelVersions, {
    fields: [panelVersionJudges.panelVersionId],
    references: [panelVersions.id],
  }),
  judgeVersion: one(judgeVersions, {
    fields: [panelVersionJudges.judgeVersionId],
    references: [judgeVersions.id],
  }),
}))

export const apiKeysRelations = relations(apiKeys, ({ one, many }) => ({
  org: one(orgs, { fields: [apiKeys.orgId], references: [orgs.id] }),
  panel: one(panels, { fields: [apiKeys.panelId], references: [panels.id] }),
  /** What this key has been used for — the per-key usage meter's join (ADR-0003). */
  traces: many(traces),
}))

export const tracesRelations = relations(traces, ({ one, many }) => ({
  org: one(orgs, { fields: [traces.orgId], references: [orgs.id] }),
  panel: one(panels, { fields: [traces.panelId], references: [panels.id] }),
  panelVersion: one(panelVersions, {
    fields: [traces.panelVersionId],
    references: [panelVersions.id],
  }),
  apiKey: one(apiKeys, { fields: [traces.apiKeyId], references: [apiKeys.id] }),
  verdicts: many(traceVerdicts),
}))

export const traceVerdictsRelations = relations(traceVerdicts, ({ one }) => ({
  trace: one(traces, { fields: [traceVerdicts.traceId], references: [traces.id] }),
  judgeVersion: one(judgeVersions, {
    fields: [traceVerdicts.judgeVersionId],
    references: [judgeVersions.id],
  }),
}))

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  org: one(orgs, { fields: [auditEvents.orgId], references: [orgs.id] }),
}))

/**
 * better-auth's tables get relations too. It does not use them — it goes through its own
 * adapter — but the console does: "this member, and who they are" is one query rather than
 * two, and leaving a hole in the graph here would be an inconsistency someone trips over
 * at P7 rather than a decision.
 */
export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  memberships: many(orgMembers),
}))

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.userId], references: [user.id] }),
}))

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.userId], references: [user.id] }),
}))
