# ADR-0046: The console adopts shadcn/ui, and `tokens.css` becomes its theme

**Status:** Accepted · **Date:** 2026-09-11 · **Milestone:** M4

## Decision
`apps/web` adopts **shadcn/ui** for component primitives, recorded as STACK_DECISIONS **D17**.
Tailwind enters as a consequence of that choice.

The approved `mockups/tokens.css` is **converted into shadcn's theming convention** — its
variable names and selector shapes — rather than living alongside it. There stays exactly one
token source, and it is the approved one: the library is themed BY our palette instead of
shipping its own.

Two conversion rules are part of the decision, not implementation detail:

- **shadcn's names are ALIASES onto ours; ours are never flattened to fit.** Our vocabulary is
  the richer of the two — `--color-line-soft` / `--color-line` / `--color-line-strong` collapse
  onto shadcn's single `--border`, and shadcn has no equivalent of the `data-density` axis at
  all. Mapping in that direction would quietly discard approved design decisions.
- **The selector convention is ours.** shadcn keys dark off a `.dark` class; the approved tokens
  use three attribute axes (`data-tone`, `data-surface`, `data-density`). Tailwind v4's
  `@custom-variant` expresses this, as deliberate setup rather than a default.

`mockups/` is untouched: `panel-create.html` stays plain HTML + CSS. CLAUDE.md's hard rule
governs the mockup, Phase C rebuilds clean from the approved brief, and the library therefore
exists only in `apps/web`.

## Context
`apps/web` has had no CSS dependency of any kind since M0, where being unstyled was the point —
the plumbing was the deliverable and anything that made it look finished would have obscured
that. M4 changes the question, because M4 ships the screen the interviewer demo opens on.

What actually forced the decision is the **model picker**. It is a searchable combobox over a
few-hundred-entry catalogue, each option carrying cost, measured latency, latency spread and a
post-pin endpoint count, beside an effort dial with per-model consequences
(`thoughts/shared/research/2026-08-30_model-tier-measurements.md`). Add the one-time key-reveal
dialog, and M4 needs a real combobox and a real focus-trapped dialog. Hand-rolling those
accessibly — roving tabindex, ARIA relationships, focus restoration — is undifferentiated work,
and this is the same argument ADR-0020 used to stop reimplementing nginx: a static file server
was not the part worth demonstrating from scratch, and neither is a listbox.

### Alternatives considered

**Radix Primitives, Base UI, React Aria Components.** All three are headless: they ship zero CSS
and would have left `tokens.css` untouched as the single aesthetic decision point, which made
them the lower-friction answer to CLAUDE.md's hard rule. Rejected in favour of shadcn on the
stakeholder's call, with the rule satisfied by conversion instead of by avoidance. Radix remains
underneath shadcn regardless, so its primitives are in the tree either way.

**No library — plain CSS on `tokens.css`.** The M0 status quo extended. Rejected because it puts
the combobox and the dialog back in scope as hand-written accessible components.

**shadcn as shipped, with Tailwind's theme as a second token system.** This is the version that
genuinely conflicts with CLAUDE.md, and it is the one NOT taken. The objection was raised before
the decision and answered by the conversion condition above rather than waived.

## Consequences
- **Tailwind and a build-step configuration enter `apps/web`**, which has had neither.
- **shadcn components are COPIED into the repo, not versioned as a dependency.** They are ours to
  maintain and receive no upstream fixes — the trade the model makes in exchange for ownership,
  and the reason this is a stack row rather than a library install.
- The Dependabot and `bun audit` surface grows, on a repo whose CI already fails a PR on any
  unrelated high advisory.
- **`tokens.css` stops being a mockup-only artifact.** It becomes application source, which is
  the first time Phase A output crosses into `apps/web`. This is not the thing CLAUDE.md's
  Phase C rule forbids: the rule is against porting mockup *HTML* as scaffold, and the tokens
  were always the one approved, reusable output of Phase A.
- The conversion is reviewable as a diff against a file with an existing approval, so a lost or
  altered design token is visible rather than inferred.
- If the alias layer is ever dropped and shadcn's vocabulary becomes the source, this ADR is
  what says that was a change of decision rather than a refactor.

Log: `thoughts/shared/progress/decisions-log.md` (2026-09-11)
Register: STACK_DECISIONS D17
Research: `thoughts/shared/research/2026-09-11_m4-console-auth.md` (decision 2)
