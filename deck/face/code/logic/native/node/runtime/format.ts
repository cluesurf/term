// Runtime shim for the `width-style` helper (SSR): splices a `width:<value>px` fragment between a branch's fixed style
// prefix and suffix, via the host String + string concat. Provided to Seed via <global:format> (docked `name format`, so
// this object IS the binding); the .tree side calls `format.widthStyle`. Identical to the browser shim -- the server
// render needs the same px strings for the width-dependent columns.
export const format = {
  widthStyle(before: string, value: number, after: string): string {
    return before + 'width:' + String(value) + 'px' + after
  },

  // a numeric opacity as a plain string ("0", "0.7", "1"), for the inline `opacity` the text-visibility machine writes
  // per phase. An absent settled opacity coalesces to 1 (React's `opacity ?? 1`); an explicit 0 is preserved.
  opacity(value: number): string {
    return String(value == null ? 1 : value)
  },

  // a transition-duration fragment ("200ms"), for the inline transition the text-visibility machine writes while a
  // fade is running.
  duration(value: number): string {
    return String(value) + 'ms'
  },

  // current high-resolution time in ms (SSR). Never drives a committed visibility decision (the server render is
  // re-rendered on the client), but present so the abstract `now-ms` resolves on both platforms.
  now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now()
  },

  // the font class token for a family + suffix ("font-CrowMark", "font-CrowMark-fallback", "font-CrowMark-waiting").
  // Same as the browser shim -- the SSR render needs the same class tokens.
  fontClass(family: string, suffix: string): string {
    // No font -> no class, matching React's buildFontClassName (returns '' when there is no font).
    if (!family) {
      return ''
    }
    return 'font-' + family.replace(/\s+/g, '') + suffix
  },
}
