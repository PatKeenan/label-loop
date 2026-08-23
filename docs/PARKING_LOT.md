# Parking Lot — ideas that fit no current milestone

- Deeper platform AI-security features (tenant-facing content moderation, injection
  scanning as a service) — deliberately out of scope under the shared-responsibility
  model; revisit only if productized as a classifier template.
- Interview talking track: shared responsibility (AWS analogy) + judge-injection
  hardening + injection-detector showcase tenant = the AI-security answer.

## From the 2026-08-22 judge-as-a-service framing conversation
Full context: `thoughts/shared/research/2026-08-22_judge-as-a-service-reframe.md`.

- **Hosted execution of deterministic checks.** Failure modes that reduce to a schema
  assertion or a regex should become code checks rather than LLM judges (near-zero cost
  and latency, perfect precision by construction). The stakeholder's position is that
  LabelLoop should *host and run* that code so the whole loop — versioning, audit trail,
  metrics, dashboard — stays in one place, rather than the check living in the customer's
  codebase where we cannot see it. The product logic is sound. **The cost is that
  executing arbitrary customer code is a security-boundary product in its own right**
  (sandbox escape, resource exhaustion, network egress, secret exfiltration), and it
  conflicts with the deployment story in ADR-0009/0013.
  **Cheaper path worth evaluating first:** do not execute arbitrary code — execute
  *constrained declarative* checks (JSON Schema, regex, JSONPath assertions, or a small
  expression language such as CEL or JSONLogic). That covers "does this match the
  structure" essentially completely, with no sandbox and no escape risk, and stays fully
  hosted. Arbitrary code execution then becomes a later escalation only if declarative
  proves insufficient. If it ever is built, a sandbox runtime is a **STACK_DECISIONS row
  and needs an ADR** — it shapes architecture and hosting.

- **AI-authored deterministic checks.** An in-app feature where an SME observation such as
  "doesn't fit the structure" is turned by the platform into a generated check that the
  developer reviews and approves. Compelling demo and a natural fit with the axial-coding
  triage step. Depends on the item above for execution, but not for authoring — generating
  a JSON Schema is useful even if the customer runs it themselves.

- **Rubric-driven auto-optimisation.** Automatically optimising prompts or configs against
  the rubric and the expert's evaluations (DSPy-shaped). Fits no current milestone; named
  here so it is not silently absorbed into M6/M7.
