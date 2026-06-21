// Runtime shim for the `observe-size` dom primitive: wraps ResizeObserver so the .tree side never expresses the
// observer construction + entry extraction. Provided to Seed via <global:resize> (docked `name resize`, so this object
// IS the binding); the dom calls `resize.observeSize`. A namespace object (not a top-level function) so the bundled
// client has no name collisions. `observeSize(el, cb)` calls `cb(width)` on every resize (and once now) with the
// element's current content-box width.
export const resize = {
  observeSize(el: HTMLElement, cb: (width: number) => void): ResizeObserver {
    const ro = new ResizeObserver(() => cb(el.clientWidth))
    ro.observe(el)
    cb(el.clientWidth)
    return ro
  },
}
