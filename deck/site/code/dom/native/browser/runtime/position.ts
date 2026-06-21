// Runtime shim for the `anchor` dom primitive: wraps @floating-ui/dom so the .tree side never expresses the middleware
// assembly or the autoUpdate loop. Provided to Seed via <global:position>; the build prepends it next to the browser
// dom impl that docks it. `anchor` positions `panel` against `reference` (offset + optional flip + shift), applies
// `position: fixed; left; top`, and keeps it synced on scroll / resize. It returns a cleanup function that stops the
// tracking and is registered with on-cleanup so the overlay tears down with no dangling listeners.
import {
  computePosition,
  offset as offsetMiddleware,
  flip as flipMiddleware,
  shift as shiftMiddleware,
  autoUpdate,
} from '@floating-ui/dom'
import type { Middleware, Placement } from '@floating-ui/dom'

export function anchor(
  reference: HTMLElement,
  panel: HTMLElement,
  placement: string,
  offset: number,
  flip: boolean,
  shift: boolean,
): () => void {
  const middleware: Middleware[] = [offsetMiddleware(offset)]

  if (flip) {
    middleware.push(flipMiddleware())
  }

  if (shift) {
    middleware.push(shiftMiddleware({ padding: 8 }))
  }

  const apply = (): void => {
    computePosition(reference, panel, {
      placement: placement as Placement,
      strategy: 'fixed',
      middleware,
    }).then(({ x, y }) => {
      panel.style.position = 'fixed'
      panel.style.left = `${x}px`
      panel.style.top = `${y}px`
    })
  }

  // autoUpdate runs `apply` immediately and on every scroll / resize / layout shift, and returns the cleanup
  return autoUpdate(reference, panel, apply)
}
