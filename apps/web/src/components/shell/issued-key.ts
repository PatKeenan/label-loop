/**
 * The one-time key plaintext, held in memory between creating a panel and landing on its
 * Overview — and nowhere else, ever.
 *
 * **Why this exists.** A panel is created with a key (ADR-0061, 6c decision 7) and the
 * plaintext is returned exactly once, by that one response; LabelLoop stores only a SHA-256.
 * The create flow then navigates to the panel's Overview, which is where the snippet lives,
 * so the value has to survive one client-side navigation.
 *
 * **Why not `localStorage`, `sessionStorage`, or the URL.** All three would write a live
 * credential somewhere it outlives the moment: storage survives a reload and is readable by
 * anything that runs script on this origin, and a URL ends up in history, in a shared link,
 * and in any log that records a path. A module-level map dies with the tab, which is exactly
 * the lifetime the key is supposed to have — losing it on reload is CORRECT behaviour, not a
 * bug to fix later, and the screen says so.
 *
 * So: a reload after creating a panel loses the plaintext, and the Overview then renders the
 * snippet with a placeholder and points at the Keys section. That is the honest outcome, and
 * it is the same one a person gets by closing the tab.
 */
const issued = new Map<string, string>()

/** Remember the plaintext this panel was created with, for this tab's lifetime. */
export const rememberIssuedKey = (panelId: string, plaintext: string): void => {
  issued.set(panelId, plaintext)
}

/** The plaintext, if this tab is the one that created the panel. `null` otherwise. */
export const issuedKeyFor = (panelId: string): string | null => issued.get(panelId) ?? null

/**
 * Drop everything on sign-out, for the same reason the query cache is invalidated there:
 * nothing read or minted as one account may be shown to the next.
 */
export const forgetIssuedKeys = (): void => {
  issued.clear()
}
