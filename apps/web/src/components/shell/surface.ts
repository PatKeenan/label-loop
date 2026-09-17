import { useLayoutEffect } from 'react'

/**
 * Put a surface preset on `<html>` for as long as this surface is mounted.
 *
 * **This exists because of portals, and it is not optional decoration.** Radix — and therefore
 * every shadcn overlay: the dropdown menus behind both switchers, the Dialog the key reveal
 * and revoke confirmation use, the Sheet, tooltips, and Sonner's toast — renders its content
 * into `document.body`, OUTSIDE the element that carries `data-surface="console"`. The
 * approved tokens resolve tone by ancestry, so a portalled menu sits outside the console's
 * scope and every one of its tokens falls back to the `:root` default, which is LIGHT.
 *
 * The symptom is a white menu on a dark console, with no error anywhere: the tokens are all
 * defined, they are simply being read from the wrong scope. It was caught by looking at the
 * running console rather than by any test — the 6b mockup could not have surfaced it, because
 * its menus are `<details>` elements that never leave the tree.
 *
 * Mirroring the preset onto the document element puts every portal back inside a scope that
 * resolves the same way, and costs one attribute.
 *
 * ---
 *
 * **Why `useLayoutEffect`**, and why the frame ALSO keeps its own `data-surface`: a plain
 * effect runs after paint, so the first frame of a hard reload would render light and then
 * correct itself. This runs before paint, and the attribute on the frame means in-tree content
 * is never even momentarily wrong. The two are the same preset, never contradicting ones —
 * which is the case `tokens.css` warns about ("use the preset or the axes, never both on the
 * same element").
 *
 * **Why it restores rather than clears**: M5's annotator surface is the other preset on the
 * other route, and a surface unmounting should hand back whatever it found rather than assume
 * it was the only one. Today nothing nests; that is exactly when this is cheap to get right.
 */
export const useSurface = (surface: 'console' | 'annotator') => {
  useLayoutEffect(() => {
    const root = document.documentElement
    const previous = root.getAttribute('data-surface')
    root.setAttribute('data-surface', surface)
    return () => {
      if (previous === null) root.removeAttribute('data-surface')
      else root.setAttribute('data-surface', previous)
    }
  }, [surface])
}
