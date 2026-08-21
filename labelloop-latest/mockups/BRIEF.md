# Mockup Brief v2 — Phase A (reduced to load-bearing screens)

v1 of this brief listed 12 screens; that was platform design, not spec. Phase A now
covers ONLY the three screens the demo narrative depends on. Everything else ships as
unstyled tables when a BUILD_SPINE milestone needs it.

## Rules (unchanged)
- Plain HTML + CSS, no frameworks or build step. Every screen imports `tokens.css`.
- tokens.css is created FIRST and approved before any screen.
- Realistic fake data (real-looking inputs, labels, costs). Lorem ipsum hides UX problems.
- Header comment per file: screen name, role, PRODUCT.md section, open questions.
- Mockups are disposable spec — screenshotted into the release brief, then rebuilt clean.

## Screens
1. `annotator-session.html` (P0) — one trace at a time, plain language, agree/correct,
   failure note, session goal. The product thesis. [PRODUCT.md 5.5]
2. `console-dashboard.html` (P0) — quality by classifier version, judge-vs-human
   agreement, cost per call frontier vs fine-tune. The receipts. [PRODUCT.md 5.10]
3. `classifier-create.html` (P1) — wizard: name, labels, prompt/context, model →
   version 1 + API key reveal (shown once). The interviewer's entry point. [5.2, 5.1]

## Deferred (unstyled until a milestone demands better)
trace explorer, taxonomy builder, fine-tune screens, guest-expert invite, billing
(Stripe-hosted where possible), audit log viewer, annotator home/gamification.

## Approval checklist
- [ ] tokens.css
- [ ] annotator-session
- [ ] console-dashboard
- [ ] classifier-create
