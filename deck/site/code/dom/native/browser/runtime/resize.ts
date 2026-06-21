// Runtime shim for the `observe-size` dom primitive: wraps ResizeObserver so the .tree side never expresses the
// observer construction + entry extraction. Provided to Seed via <global:resize>; the build prepends it next to the
// browser dom impl that docks it. `observeSize(el, cb)` calls `cb(width)` on every resize (and once immediately) with
// the element's current content-box width.
export function observeSize(el: HTMLElement, cb: (width: number) => void): ResizeObserver {
  const ro = new ResizeObserver(() => cb(el.clientWidth))
  ro.observe(el)
  cb(el.clientWidth)
  return ro
}
