# ADR-0062: A persistent top bar, and a sidebar only inside a panel

**Status:** Accepted · **Date:** 2026-09-17 · **Milestone:** M4
**Supersedes:** ADR-0056's "two levels, one persistent sidebar" (the rest of ADR-0056 stands)

## Decision
The console's frame is a **top bar present at every level**, and a **sidebar that exists only
inside a panel**.

The bar carries the wordmark (which links Home), the scope as a trail (`org` at Home,
`org / panel` in a panel), the organisation control, and the account menu. The sidebar carries
the panel switcher and that panel's section nav, and is absent everywhere else.

**Home is the panel list** — a grid of cards, each carrying its state, trace count, judge count
and age — with Create panel as its action, which CONSOLE_FLOW §4 already said it was.

**Creating a panel is a dialog**, opened by `?new` on any route, rather than a screen.

## Context
ADR-0056, as amended at the 6b review on 2026-09-15, chose ONE persistent sidebar across both
levels, explicitly over a swapping one. The reason is on record and is worth restating, because
it is what shaped this replacement rather than what this replacement discards:

> a swapping sidebar hides Home behind a back button, where a persistent one with a back ARROW
> keeps the forward/back feeling without losing Home.

**That objection was correct.** It is answered here by the top bar rather than by the sidebar.
The bar does not come and go, so Home is never behind anything — which a sidebar that simply
vanished would not have achieved. This is why the decision is not the rejected design returning
two days later.

**What forced it was rendering the approved screen against real data.** The 6b and 6c mockups
drew Home with its content slot full of descriptive prose, so the rail never looked empty beside
it. Built, on a real organisation at a real width, the sidebar at Home was a wordmark, a Home
row, a panel switcher, and then roughly nine hundred pixels of nothing. The stakeholder saw it
in one look at the running console (2026-09-17); no amount of reviewing the drawing would have
shown it, and that is the honest lesson rather than a criticism of the review.

**Two bugs surfaced in the same look, and they are evidence for the same point.** The shell
conflated "no panel is open" with "at Home", so on the Create panel page it marked Home as the
CURRENT page while you were somewhere else, and rendered it as a non-clickable span — leaving
that screen with no way back except a wordmark nobody had been told was a link. A level that
had no sidebar content of its own was being described by a control built for a level that did.

**Create panel went page → dialog within the same review.** It was briefly a full page with a
back link; the stakeholder rejected that too, correctly: three fields on a whole screen strand a
form in a very wide empty stage, and give the one screen with nothing to navigate its own
navigation problem. You come from the list, make one thing, and go back to the list — which is
a dialog. It is URL-driven (`?new`) because it has two triggers in different trees, Home's button
and the panel switcher's menu item, and a URL makes the back button close it for free.

**The dialog's first version opened and closed in one click**, and the cause is worth keeping:
its triggers are router `Link`s, not a `DialogTrigger`, so Radix's dismissable layer does not
know to ignore the click that opened it. Pasting the URL always worked, which is what located it.
The guard ignores a dismissal arriving within 250ms of opening.

## Consequences
- **The rule CONSOLE_FLOW §4 states becomes structural.** *"If it is in the section nav, it
  belongs to the panel named above it"* is now enforced by there being no section nav outside a
  panel, rather than by everyone remembering.
- **The panel switcher stays in the sidebar**, not the bar. Jumping between panels without
  going Home still works; choosing one from nothing is Home's job, which is what "Home is the
  list" means.
- **Organisation settings move to the account menu** — still admin-only and still absent in
  substance until M8 (ADR-0059). Hiding or disabling it mirrors the server guard and never
  replaces it.
- **`mockups/console-shell.html` r3 no longer describes the built shell.** It is disposable
  spec (CLAUDE.md Phase C) and is NOT being redrawn: the screen it describes was reviewed, built,
  and found wanting in the one way a drawing could not show. `CONSOLE_FLOW.md` §2 is corrected,
  because that document is the map rather than a drawing.
- **The 6b review's decisions 1 and 2 are superseded**; decisions 3, 4, 4b, 5, 7, 8, 9, 10, 11
  and 12 stand unchanged — the panel switcher IS the panels section, every nav item belongs to
  its panel, padlocks differ from milestone marks, the three error surfaces, the two modal
  temperaments.
- **This was built directly rather than mocked first**, on the stakeholder's call, which is a
  deliberate step outside the Phase A methodology for one change. Recorded here so that is a
  decision rather than a lapse.
- **`mockups/tokens.css` was edited in the same session** — compact's SPACING opened, its TYPE
  untouched, and a `--pad-bar-*` pair added for the bar this ADR introduces. See the note in §5
  of that file; the change is the approved file's, copied verbatim into `apps/web`, so the
  ADR-0046 diff check still reports nothing lost.

Raised by the stakeholder, 2026-09-17, looking at the running console during M4 phase 8.
Record: `thoughts/shared/progress/decisions-log.md` · Plan: M4 phase 8
