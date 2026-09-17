import { useRef } from 'react'

/**
 * Keep the focus ring for keyboard users and off a mouse user's screen.
 *
 * **The problem it solves.** Radix returns focus to the trigger when a menu closes, and it does
 * so PROGRAMMATICALLY — which Chrome treats as keyboard-ish, so `:focus-visible` matches and
 * the trigger keeps the approved `--shadow-focus` ring after a plain click. That ring is 4px of
 * `--graphite-paper` drawn OUTSIDE the element, so on the sidebar it reads as a bright white
 * box around the switcher rather than as a focus indicator, and it sits directly against the
 * first nav row below (measured: `matches(':focus-visible')` true, `box-shadow` the full ring,
 * on a `data-state="closed"` trigger).
 *
 * **Why not just drop the ring.** It is the approved focus treatment in `tokens.css`, and it is
 * how a keyboard user knows where they are. Removing it to fix a mouse-only artifact would
 * trade an accessibility affordance for a cosmetic one.
 *
 * **What this does instead.** It records whether the menu was opened by POINTER, and if so
 * prevents Radix's focus return on close. A mouse user gets no stuck ring; a keyboard user —
 * who opened with Enter, Space or an arrow key — still lands back on the trigger, ringed, which
 * is the behaviour that matters. Escape from a pointer-opened menu also drops the ring, which
 * is the one case this gets mildly wrong, and it is the trade worth making.
 *
 * Returns props to spread onto the trigger and the content respectively.
 */
export const useMenuFocusReturn = () => {
  const openedByPointer = useRef(false)

  return {
    triggerProps: {
      onPointerDown: () => {
        openedByPointer.current = true
      },
      onKeyDown: () => {
        openedByPointer.current = false
      },
    },
    contentProps: {
      onCloseAutoFocus: (event: Event) => {
        if (openedByPointer.current) event.preventDefault()
      },
    },
  }
}
